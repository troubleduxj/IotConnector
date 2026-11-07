package storage

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// literalBody 模拟 TDengine 解析单引号字面量：遇到 \x 取 x，遇到未转义的 ' 即结束。
// 返回解析出的值，以及字面量是否恰好在输入末尾结束（未提前闭合）。
func literalBody(escaped string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(escaped); i++ {
		switch escaped[i] {
		case '\\':
			if i+1 >= len(escaped) {
				return b.String(), false
			}
			i++
			b.WriteByte(escaped[i])
		case '\'':
			return b.String(), false
		default:
			b.WriteByte(escaped[i])
		}
	}
	return b.String(), true
}

func TestEscRoundTripsQuotesAndBackslashes(t *testing.T) {
	cases := []string{
		"plain",
		"O'Brien",
		`C:\path\tag`,
		`ends with backslash\`,
		`\'`,
		`'); DROP TABLE x; --`,
		"温度'传感器\\1",
	}
	for _, in := range cases {
		got, closed := literalBody(esc(in))
		if !closed {
			t.Fatalf("esc(%q) = %q closes the literal early", in, esc(in))
		}
		if got != in {
			t.Fatalf("esc(%q) round-trip = %q", in, got)
		}
	}
}

func TestEscReplacesControlCharacters(t *testing.T) {
	if got := esc("a\nb\rc\x00d\x7f"); got != "a b c d " {
		t.Fatalf("esc control chars = %q", got)
	}
}

func TestEscNTruncatesWithoutSplittingUTF8(t *testing.T) {
	in := strings.Repeat("温", 50) // 150 字节
	got := escN(in, 128)
	if len(got) > 128 || !utf8.ValidString(got) {
		t.Fatalf("escN len=%d valid=%v", len(got), utf8.ValidString(got))
	}
	if got != strings.Repeat("温", 42) {
		t.Fatalf("escN cut at wrong rune boundary: %d bytes", len(got))
	}
	if escN("short", 128) != "short" {
		t.Fatal("escN changed a short value")
	}
}

// 回归 C1：位号名含单引号时，原实现生成的 SQL 留下裸引号，整批写入失败并卡在队首。
func TestQuotedTagNameStaysWellFormed(t *testing.T) {
	name := "Line1'Temp"
	body, closed := literalBody(escN(name, 128))
	if !closed || body != name {
		t.Fatalf("tag name %q not safely quoted: %q", name, escN(name, 128))
	}
}
