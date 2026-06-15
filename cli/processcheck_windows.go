//go:build windows

package cli

import (
	"syscall"
	"time"
)

func platformProcessAlive(pid int) bool {
	const processQueryLimitedInformation = 0x1000

	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)

	var exitCode uint32
	err = syscall.GetExitCodeProcess(h, &exitCode)
	if err != nil {
		return false
	}
	// STILL_ACTIVE = 259
	return exitCode == 259
}

func platformSendTermination(pid int) {
	const processTerminate = 0x0001

	h, err := syscall.OpenProcess(processTerminate, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)

	// On Windows, there is no SIGTERM equivalent.
	// We forcefully terminate the process.
	_ = syscall.TerminateProcess(h, 1)

	// Give Windows a moment to clean up
	time.Sleep(100 * time.Millisecond)
}

func platformForceKill(pid int) {
	const processTerminate = 0x0001

	h, err := syscall.OpenProcess(processTerminate, false, uint32(pid))
	if err != nil {
		return
	}
	defer syscall.CloseHandle(h)

	_ = syscall.TerminateProcess(h, 1)
}
