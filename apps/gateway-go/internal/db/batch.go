package db

import (
	"context"
	"database/sql"
	"log"
	"sync"
	"time"
)

// Batch 把各状态存储的写操作合并为定时提交的事务（C3）。
//
// 原实现每个样本都重写或 fsync 一次文件；改为写入内存待提交队列，由 Run 每 interval
// 或积累 maxOps 条时提交一个事务。代价是崩溃时最多丢失一个间隔内的写入，换取写放大
// 从 O(队列长度) 降到 O(1)。所有存储共用一个 Batch，保证跨表写入顺序与 SQLite 单写者一致。
type Batch struct {
	db       *DB
	mu       sync.Mutex
	ops      []op
	flushMu  sync.Mutex
	kick     chan struct{}
	maxOps   int
	maxQueue int
	dropped  int
	failures int
}

type op struct {
	query string
	args  []any
}

const (
	defaultBatchOps   = 500
	defaultBatchQueue = 200_000
)

func NewBatch(database *DB) *Batch {
	return &Batch{db: database, kick: make(chan struct{}, 1), maxOps: defaultBatchOps, maxQueue: defaultBatchQueue}
}

// Exec 追加一条写操作，不阻塞。待提交队列超过上限时丢弃最旧的操作（磁盘长期不可写时防止内存无限增长）。
func (b *Batch) Exec(query string, args ...any) {
	if b == nil {
		return
	}
	b.mu.Lock()
	if len(b.ops) >= b.maxQueue {
		b.ops = b.ops[1:]
		b.dropped++
	}
	b.ops = append(b.ops, op{query: query, args: args})
	full := len(b.ops) >= b.maxOps
	b.mu.Unlock()
	if full {
		select {
		case b.kick <- struct{}{}:
		default:
		}
	}
}

// Flush 立即提交全部待写操作。读操作若需要看到刚追加的写入，应先调用 Flush。
// 提交失败时操作放回队首，下次重试。
func (b *Batch) Flush(ctx context.Context) error {
	if b == nil {
		return nil
	}
	b.flushMu.Lock()
	defer b.flushMu.Unlock()
	b.mu.Lock()
	pending := b.ops
	b.ops = nil
	b.mu.Unlock()
	if len(pending) == 0 {
		return nil
	}
	if err := b.commit(ctx, pending); err != nil {
		b.mu.Lock()
		b.ops = append(pending, b.ops...)
		if over := len(b.ops) - b.maxQueue; over > 0 {
			b.ops = b.ops[over:]
			b.dropped += over
		}
		b.failures++
		b.mu.Unlock()
		return err
	}
	return nil
}

func (b *Batch) commit(ctx context.Context, ops []op) error {
	tx, err := b.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	statements := map[string]*sql.Stmt{}
	defer func() {
		for _, stmt := range statements {
			_ = stmt.Close()
		}
	}()
	for _, item := range ops {
		stmt, ok := statements[item.query]
		if !ok {
			stmt, err = tx.PrepareContext(ctx, item.query)
			if err != nil {
				_ = tx.Rollback()
				return err
			}
			statements[item.query] = stmt
		}
		if _, err := stmt.ExecContext(ctx, item.args...); err != nil {
			_ = tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// Run 按 interval 定时提交，直到 ctx 结束；结束时做最后一次提交（有序关停，C10）。
func (b *Batch) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			final, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := b.Flush(final); err != nil {
				log.Printf("final state flush failed: %v", err)
			}
			cancel()
			return
		case <-ticker.C:
		case <-b.kick:
		}
		if err := b.Flush(ctx); err != nil && ctx.Err() == nil {
			log.Printf("state flush failed (will retry): %v", err)
		}
	}
}

// Stats 返回待提交数、累计丢弃数与提交失败次数，供监控接口使用。
func (b *Batch) Stats() (pending, dropped, failures int) {
	if b == nil {
		return 0, 0, 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.ops), b.dropped, b.failures
}

// NextID 返回表中 id 列的最大值，供存储在内存中继续分配显式 id。
// 显式 id 让“删除已发送的前 N 条”变成按 id 范围删除，不依赖提交时机。
func (db *DB) NextID(ctx context.Context, table string) (int64, error) {
	var max sql.NullInt64
	if err := db.QueryRowContext(ctx, "SELECT MAX(id) FROM "+table).Scan(&max); err != nil {
		return 0, err
	}
	return max.Int64, nil
}
