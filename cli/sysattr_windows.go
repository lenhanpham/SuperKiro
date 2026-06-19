//go:build windows

package cli

import (
	"os/exec"
	"syscall"
)

// Process creation flags from the Windows API.
// Go's syscall package defines CREATE_NEW_PROCESS_GROUP but not DETACHED_PROCESS.
const (
	detachedProcess = 0x00000008
)

func setDetached(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: detachedProcess,
	}
}
