// SPDX-License-Identifier: GPL-3.0-only
#pragma once
// Run scripts/prepare-provisioning-poc.mjs once. It creates an ignored local
// private_config.h and a local connection card; it never prints the password.
// This is a separate test AP secret, never your router's Wi-Fi password.
#define FOCUSDESK_POC_AP_PASSWORD ""
