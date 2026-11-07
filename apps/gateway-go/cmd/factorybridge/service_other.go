//go:build !windows && !linux

package main

import (
	"context"
	"io"
)

func runServiceAction(string, serviceOptions, io.Writer) error { return errNotSupported }

func runningUnderSCM() bool { return false }

func runAsWindowsService(string, func(context.Context) int) int { return exitUsage }
