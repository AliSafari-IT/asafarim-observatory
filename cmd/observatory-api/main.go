package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/AliSafari-IT/asafarim-observatory/api"
)

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run() error {
	address := flag.String("addr", "127.0.0.1:8080", "loopback address for the local API")
	root := flag.String("root", ".", "workspace directory used by the collector")
	history := flag.String("history", ".observatory/snapshots", "saved snapshot history directory")
	analyzer := flag.String("analyzer", "analysis/analyze.py", "Python analyzer script")
	python := flag.String("python", "python3", "Python executable")
	dashboard := flag.String("dashboard", "", "optional built dashboard directory to serve on the API origin")
	timeout := flag.Duration("timeout", 10*time.Second, "analysis deadline")
	summaryTimeout := flag.Duration("summary-timeout", 60*time.Second, "AI summary generation deadline")
	version := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if flag.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if *version {
		fmt.Println("observatory-api " + api.Version)
		return nil
	}
	if *summaryTimeout <= 0 {
		return errors.New("summary timeout must be positive")
	}
	if err := validateAddress(*address); err != nil {
		return err
	}
	handler, err := api.New(api.Config{Root: *root, History: *history, Analyzer: *analyzer, Python: *python, Timeout: *timeout, SummaryTimeout: *summaryTimeout})
	if err != nil {
		return err
	}
	if *dashboard != "" {
		var closeDashboard func() error
		handler, closeDashboard, err = api.WithDashboard(handler, *dashboard)
		if err != nil {
			return err
		}
		defer closeDashboard()
	}
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	server := &http.Server{
		Handler: handler, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: max(*timeout, *summaryTimeout) + 5*time.Second,
		IdleTimeout: 60 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	log.Printf("Observatory API %s listening on http://%s", api.Version, listener.Addr())
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			server.Close()
			return err
		}
		if err := <-done; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	}
}

func validateAddress(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		return errors.New("use a loopback IP address, such as 127.0.0.1:8080")
	}
	return nil
}
