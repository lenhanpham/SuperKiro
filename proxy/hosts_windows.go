//go:build windows

package proxy

import "os"

var hostsFilePath = os.ExpandEnv(`%SystemRoot%\System32\drivers\etc\hosts`)
var hostsTmpPath = hostsFilePath + ".tmp"
