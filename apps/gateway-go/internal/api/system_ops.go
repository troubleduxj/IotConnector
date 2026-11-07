package api

import "net/http"

// 配置备份恢复、恢复出厂、调度重平衡。由子任务 B 实现。

func (s *Server) configBackup(w http.ResponseWriter, r *http.Request)       { notImplemented(w) }
func (s *Server) configRestore(w http.ResponseWriter, r *http.Request)      { notImplemented(w) }
func (s *Server) factoryReset(w http.ResponseWriter, r *http.Request)       { notImplemented(w) }
func (s *Server) rebalanceScheduler(w http.ResponseWriter, r *http.Request) { notImplemented(w) }
