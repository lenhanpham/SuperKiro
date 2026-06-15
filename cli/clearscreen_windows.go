//go:build windows

package cli

import (
	"fmt"
	"os/exec"
)

func clearScreen() {
	// Try ANSI escapes first (works on Windows 10+ Terminal / PowerShell)
	cmd := exec.Command("cmd", "/c", "cls")
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Run(); err != nil {
		// Fallback: print newlines
		fmt.Print("\033[2J\033[H\033[3J")
	}
}
