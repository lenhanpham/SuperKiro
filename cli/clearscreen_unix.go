//go:build !windows

package cli

import "fmt"

func clearScreen() {
	fmt.Print("\033[2J\033[H\033[3J")
}
