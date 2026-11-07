package main

import "testing"

func TestLoopbackAddresses(t *testing.T) {
	for _, address := range []string{"127.0.0.1:8080", "[::1]:8080", "127.0.0.1:0"} {
		if err := validateAddress(address); err != nil {
			t.Errorf("%s: %v", address, err)
		}
	}
	for _, address := range []string{":8080", "0.0.0.0:8080", "[::]:8080", "192.168.1.10:8080", "bad-address"} {
		if err := validateAddress(address); err == nil {
			t.Errorf("non-loopback address accepted: %s", address)
		}
	}
}
