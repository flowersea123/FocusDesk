// SPDX-License-Identifier: GPL-3.0-only
#pragma once
// Adafruit_GFX.h includes this BusIO header but its graphics implementation
// does not use I2C. No I2C behavior is provided or claimed by these host checks.
class Adafruit_I2CDevice;
