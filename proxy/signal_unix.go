//go:build !windows

package proxy

import "syscall"

func selfSignalInterrupt() {
	syscall.Kill(syscall.Getpid(), syscall.SIGINT)
}
