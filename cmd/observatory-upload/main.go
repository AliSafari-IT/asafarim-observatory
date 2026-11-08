package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/repository"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func quote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'" }

// Build one shell-quoted remote command. Only an SSH configuration alias is
// accepted as host, so options/usernames cannot be injected into ssh arguments.
func uploadArgs(host, receiver, root, history string) ([]string, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`).MatchString(host) || !filepath.IsAbs(receiver) || !filepath.IsAbs(history) {
		return nil, fmt.Errorf("use an SSH host alias and absolute receiver/history paths")
	}
	for _, value := range []string{receiver, root, history} {
		if strings.ContainsAny(value, "\x00\r\n") {
			return nil, fmt.Errorf("paths must not contain control characters")
		}
	}
	command := quote(receiver) + " -root " + quote(root) + " -history " + quote(history)
	return []string{"-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ClearAllForwardings=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "--", host, command}, nil
}

func run(ctx context.Context, args []string, out, errOut io.Writer) int {
	flags := flag.NewFlagSet("observatory-upload", flag.ContinueOnError)
	flags.SetOutput(errOut)
	root := flags.String("root", ".", "local workspace root")
	history := flags.String("history", ".observatory/snapshots", "local saved snapshot directory")
	host := flags.String("host", "", "SSH configuration alias (required)")
	receiver := flags.String("receiver", "", "absolute receiver executable path on server (required)")
	remoteHistory := flags.String("remote-history", "", "absolute history directory on server (required)")
	timeout := flags.Duration("timeout", 30*time.Second, "upload deadline")
	version := flags.Bool("version", false, "print version and exit")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if *version {
		fmt.Fprintln(out, "observatory-upload 0.1.0")
		return 0
	}
	if flags.NArg() != 0 || *timeout <= 0 {
		fmt.Fprintln(errOut, "invalid arguments or timeout")
		return 2
	}
	absolute, err := filepath.Abs(*root)
	if err != nil {
		return 2
	}
	sshArgs, err := uploadArgs(*host, *receiver, absolute, *remoteHistory)
	if err != nil {
		fmt.Fprintln(errOut, err)
		return 2
	}
	snapshot, err := repository.Latest(*history, absolute)
	if err != nil {
		fmt.Fprintln(errOut, "Cannot read local snapshot. Run observatory with -save first.")
		return 1
	}
	data, err := json.Marshal(snapshot)
	if err != nil || len(data) > repository.MaxSnapshotBytes {
		fmt.Fprintln(errOut, "Snapshot exceeds transfer limit or cannot be encoded.")
		return 1
	}
	ctx, cancel := context.WithTimeout(ctx, *timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ssh", sshArgs...)
	cmd.WaitDelay = time.Second
	cmd.Stdin = bytes.NewReader(data)
	ack := &acknowledgementBuffer{}
	cmd.Stdout = ack
	cmd.Stderr = errOut
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(errOut, "Snapshot upload failed. Verify SSH access and receiver configuration; retrying the same snapshot is safe.")
		return 1
	}
	var result struct {
		Status    string `json:"status"`
		Duplicate *bool  `json:"duplicate"`
	}
	if json.Unmarshal(ack.data.Bytes(), &result) != nil || result.Status != "saved" || result.Duplicate == nil {
		fmt.Fprintln(errOut, "Receiver did not acknowledge storage. Verify its configuration; retrying the same snapshot is safe.")
		return 1
	}
	fmt.Fprintf(out, "Uploaded latest saved snapshot to %s.\n", *host)
	return 0
}

type acknowledgementBuffer struct{ data bytes.Buffer }

func (b *acknowledgementBuffer) Write(p []byte) (int, error) {
	if b.data.Len()+len(p) > 4096 {
		return 0, fmt.Errorf("receiver acknowledgement exceeds limit")
	}
	return b.data.Write(p)
}
