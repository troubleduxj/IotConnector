package api

import "net/http"

// 通道导入导出、诊断包、OpenAPI 文档。由子任务 A 实现。

func (s *Server) exportChannel(w http.ResponseWriter, r *http.Request) { notImplemented(w) }
func (s *Server) importChannel(w http.ResponseWriter, r *http.Request) { notImplemented(w) }
func (s *Server) systemDiag(w http.ResponseWriter, r *http.Request)    { notImplemented(w) }
func (s *Server) openAPIDoc(w http.ResponseWriter, r *http.Request)    { notImplemented(w) }
