// SPDX-License-Identifier: GPL-3.0-only
#pragma once

// Reuse the existing deterministic clock, GPIO and serial declarations. Their
// implementations live in v02_snapshot_test.cpp; they never access a device.
#include "../live_fakes/Arduino.h"
#include <cmath>
#include <cstdlib>
#include <cstring>

// GFX's unused String overload needs only length() and c_str() on the host.
using String = std::string;
class __FlashStringHelper;
inline double radians(double degrees) { return degrees * (std::acos(-1.0) / 180.0); }
