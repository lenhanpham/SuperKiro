package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func PIDPath(configPath string) string {
	if exe, err := os.Executable(); err == nil {
		return filepath.Join(filepath.Dir(exe), "data", "superkiro.pid")
	}
	return filepath.Join(filepath.Dir(configPath), "superkiro.pid")
}

func CheckAndKillExisting(pidPath string) bool {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return false
	}

	pidStr := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(pidStr)
	if err != nil {
		os.Remove(pidPath)
		return false
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		os.Remove(pidPath)
		return false
	}

	if err := process.Signal(syscall.Signal(0)); err != nil {
		os.Remove(pidPath)
		return false
	}

	fmt.Printf("  Killing existing SuperKiro (PID: %d)...\n", pid)

	process.Signal(syscall.SIGTERM)
	time.Sleep(500 * time.Millisecond)

	if process.Signal(syscall.Signal(0)) == nil {
		process.Signal(syscall.SIGKILL)
		time.Sleep(200 * time.Millisecond)
	}

	os.Remove(pidPath)
	fmt.Println("  SuperKiro is killed.")
	return true
}

func WritePID(pidPath string) error {
	if err := os.MkdirAll(filepath.Dir(pidPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(pidPath, []byte(fmt.Sprintf("%d", os.Getpid())), 0644)
}

func RemovePID(pidPath string) {
	data, err := os.ReadFile(pidPath)
	if err != nil {
		return
	}
	pidStr := strings.TrimSpace(string(data))
	pid, err := strconv.Atoi(pidStr)
	if err != nil || pid != os.Getpid() {
		return
	}
	os.Remove(pidPath)
}
