package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// 仅支持当前发布的稳定版和平台；不让服务端提供任意跳转 URL。
type releaseEntry struct {
	Platform    string `json:"platform"`
	Arch        string `json:"arch"`
	Version     string `json:"version"`
	Notes       string `json:"notes"`
	DownloadURL string `json:"downloadUrl"`
}

type releaseManifest struct {
	Releases []releaseEntry `json:"releases"`
}

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$`)

func supportedRelease(platform, arch string) bool {
	return (platform == "darwin" && arch == "arm64") || (platform == "win32" && arch == "x64")
}

func validateRelease(item releaseEntry) error {
	if !supportedRelease(item.Platform, item.Arch) || !stableVersion.MatchString(item.Version) || len(item.Notes) > 2000 {
		return errors.New("invalid release fields")
	}
	if len(item.DownloadURL) == 0 || len(item.DownloadURL) > 2048 || strings.ContainsAny(item.DownloadURL, "\r\n\t") {
		return errors.New("invalid download URL")
	}
	u, err := url.Parse(item.DownloadURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return errors.New("download URL must be HTTPS")
	}
	return nil
}

func readReleases(path string) ([]releaseEntry, error) {
	if path == "" {
		return nil, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	const maxSize = 256 * 1024
	data, err := io.ReadAll(io.LimitReader(file, maxSize+1))
	if err != nil || len(data) > maxSize {
		return nil, errors.New("release manifest could not be read")
	}
	var manifest releaseManifest
	if err := json.Unmarshal(data, &manifest); err != nil || manifest.Releases == nil {
		return nil, errors.New("invalid release manifest")
	}
	seen := make(map[string]bool)
	for _, item := range manifest.Releases {
		if err := validateRelease(item); err != nil {
			return nil, err
		}
		key := item.Platform + "/" + item.Arch
		if seen[key] {
			return nil, fmt.Errorf("duplicate release for %s", key)
		}
		seen[key] = true
	}
	return manifest.Releases, nil
}

func latestRelease(path string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		platform, arch := c.Query("platform"), c.Query("arch")
		if !supportedRelease(platform, arch) {
			writeError(c, http.StatusBadRequest, "unsupported_platform", "不支持此平台。")
			return
		}
		releases, err := readReleases(path)
		if err != nil {
			writeError(c, http.StatusServiceUnavailable, "release_unavailable", "版本信息暂不可用。")
			return
		}
		for _, item := range releases {
			if item.Platform == platform && item.Arch == arch {
				writeOK(c, item)
				return
			}
		}
		// 显式返回 null，客户端可以区分未发布和已有最新版本。
		c.JSON(http.StatusOK, gin.H{"ok": true, "data": nil})
	}
}
