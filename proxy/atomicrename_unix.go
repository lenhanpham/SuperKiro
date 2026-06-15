//go:build !windows

package proxy

import "os"

func atomicRename(oldpath, newpath string) error {
	return os.Rename(oldpath, newpath)
}
