//go:build windows

package proxy

import "os"

func atomicRename(oldpath, newpath string) error {
	// On Windows, os.Rename fails if destination exists.
	// Remove destination first, then rename.
	_ = os.Remove(newpath)
	return os.Rename(oldpath, newpath)
}
