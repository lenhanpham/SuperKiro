//go:build windows

package proxy

import (
	"os"
	"syscall"
)

func selfSignalInterrupt() {
	p, _ := os.FindProcess(os.Getpid())
	p.Signal(syscall.SIGINT)
}
