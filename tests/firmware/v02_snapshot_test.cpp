// SPDX-FileCopyrightText: 2026 FocusDesk contributors
// SPDX-License-Identifier: GPL-3.0-only
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <iterator>
#include <vector>
#include "../../firmware/focusdesk_device/display_snapshot.h"
#include "../../firmware/experiments/focusdesk_provisioning_poc/hub_validation.h"

TestSerial Serial;
TestSPI SPI;
uint32_t clockMs = 0;
int levels[256]{};
uint8_t command = 0;
std::vector<uint8_t> image;
unsigned long millis() { return clockMs; }
void delay(unsigned long value) { clockMs += value; }
void pinMode(uint8_t, int) {}
void digitalWrite(uint8_t pin, int value) { levels[pin] = value; }
int digitalRead(uint8_t) { return HIGH; }
void TestSPI::begin(int, int, int, int) {}
void TestSPI::beginTransaction(SPISettings) {}
void TestSPI::endTransaction() {}
uint8_t TestSPI::transfer(uint8_t value) {
  if (levels[PIN_DC] == LOW) command = value;
  else if (command == 0x10) image.push_back(value);
  return 0;
}

unsigned checks = 0;
void check(bool value) {
  ++checks;
  if (!value) { std::cerr << "Failed V0.2 snapshot check " << checks << '\n'; std::exit(1); }
}
std::string scene(const std::string& commands) {
  return "{\"schema_version\":\"display-1\",\"layout_version\":\"goal-1\",\"revision\":\"goal-1:unit\","
      "\"width\":400,\"height\":300,\"commands\":" + commands + "}";
}
std::string changed(std::string value, const std::string& before, const std::string& after) {
  const auto position = value.find(before);
  check(position != std::string::npos);
  value.replace(position, before.size(), after);
  return value;
}
void rejected(const std::string& body) {
  focusdesk::DisplaySnapshot output;
  output.revision = "previous";
  output.commands.push_back({});
  const char* error = nullptr;
  check(!focusdesk::parseDisplaySnapshot(body.data(), body.size(), output, error));
  check(error != nullptr && output.revision == "previous" && output.commands.size() == 1);
}

void selfTest() {
  const auto valid = scene("[[0,0,0,400,300,1],[1,16,40,0,0,\"FocusDesk\"],[1,16,90,1,0,\"Current\"],"
      "[1,16,140,2,0,\"Your Goal\"],[2,22,172,6,2,1],[2,22,222,6,0,0]]");
  focusdesk::DisplaySnapshot snapshot;
  const char* error = nullptr;
  check(focusdesk::parseDisplaySnapshot(valid.data(), valid.size(), snapshot, error));
  check(error == nullptr && snapshot.revision == "goal-1:unit" && snapshot.commands.size() == 6);
  check(focusdesk_config::boundedHubJson(valid.data(), valid.size(), 768));
  GDEM042F52Display panel;
  check(panel.begin());
  focusdesk::drawDisplaySnapshot(panel, snapshot);
  check(panel.update() && image.size() == 30000);
  const auto at = [](int x, int y) {
    const size_t pixel = static_cast<size_t>(y) * 400 + x;
    return (image[pixel / 4] >> (6 - pixel % 4 * 2)) & 3;
  };
  check(at(0, 0) == 1 && at(399, 299) == 1);
  check(at(22, 172) == 2 && at(22, 166) == 2 && at(22, 178) == 2);
  check(at(22, 222) == 1 && at(22, 216) == 0 && at(22, 228) == 0);
  rejected(""); rejected("[]"); rejected("null"); rejected(valid + "{}");
  rejected(std::string(4097, ' '));
  rejected(changed(valid, "display-1", "display-2"));
  rejected(changed(valid, "goal-1\"", "goal-2\""));
  rejected(changed(valid, "400,\"height\"", "399,\"height\""));
  rejected(changed(valid, "300,\"commands\"", "301,\"commands\""));
  rejected(changed(valid, "\"width\":400", "\"width\":400.0"));
  rejected(changed(valid, "goal-1:unit", "has spaces"));
  rejected(changed(valid, "goal-1:unit", std::string(81, 'x')));
  rejected(changed(valid, "\"revision\":", "\"unknown\":"));
  rejected(changed(valid, "\"width\":400", "\"extra\":0,\"width\":400"));
  for (const auto& commands : {
      "null", "{}", "[null]", "[[3,1,1,1,1,1]]", "[[0,0,0,1,1]]", "[[0,0,0,1,1,0,1]]",
      "[[0,-1,0,1,1,0]]", "[[0,0,300,1,1,0]]", "[[0,399,0,2,1,0]]", "[[0,0,299,1,2,0]]",
      "[[0,0,0,0,1,0]]", "[[0,0,0,1,0,0]]", "[[0,0,0,1,1,4]]", "[[0,true,0,1,1,0]]",
      "[[1,0,20,18,0,\"text\"]]", "[[1,0,20,0,0,null]]", "[[1,0,20,0,0,\"a\\u0000b\"]]",
      "[[1,0,20,0,0,\"a\\nb\"]]", "[[1,0,20,0,0,\"\\u4e2d\"]]", "[[1,0,0,0,0,\"A\"]]",
      "[[1,399,20,0,0,\"W\"]]", "[[1,0,299,0,0,\"g\"]]", "[[1,0,20,1,0.0,\"t\"]]",
      "[[2,0,0,6,2,1]]", "[[2,22,22,0,2,1]]", "[[2,22,22,65,2,1]]", "[[2,22,22,6,2,true]]",
      "[[2,22,22,6,2,2]]", "[[2,399,299,6,2,1]]"}) rejected(scene(commands));
  rejected(scene("[[1,0,20,0,0,\"" + std::string(97, ' ') + "\"]]"));
  std::string commands = "[";
  for (int i = 0; i < 65; ++i) { if (i) commands += ','; commands += "[0,0,0,1,1,0]"; }
  commands += ']';
  rejected(scene(commands));
  commands = "[";
  for (int i = 0; i < 64; ++i) {
    if (i) commands += ',';
    commands += "[1,0,20,0,0,\"" + std::string(17, ' ') + "\"]";
  }
  commands += ']';
  rejected(scene(commands));
  const auto empty = scene("[]");
  check(focusdesk::parseDisplaySnapshot(empty.data(), empty.size(), snapshot, error));
  check(snapshot.commands.empty());
  // Default validation budget remains unchanged for provisioning replies.
  std::string many = "[";
  for (int i = 0; i < 150; ++i) { if (i) many += ','; many += '0'; }
  many += ']';
  check(!focusdesk_config::boundedHubJson(many.data(), many.size()));
  check(focusdesk_config::boundedHubJson(many.data(), many.size(), 768));

  check(focusdesk::displaySnapshotFont(0) == &FreeSans9pt7b);
  check(focusdesk::displaySnapshotFont(1) == &FreeSansBold9pt7b);
  check(focusdesk::displaySnapshotFont(2) == &FreeSansBold18pt7b);
  check(focusdesk::displaySnapshotFont(3) == &FreeSans12pt7b);
  check(focusdesk::displaySnapshotFont(4) == &FreeSansBold12pt7b);
  const auto freeSans12 = scene("[[1,16,45,3,0,\"Readable body\"],[1,16,85,4,0,\"Daily overview\"]]");
  check(focusdesk::parseDisplaySnapshot(freeSans12.data(), freeSans12.size(), snapshot, error));
  check(error == nullptr && snapshot.commands.size() == 2);
  check(snapshot.commands[0].a == 3 && snapshot.commands[1].a == 4);
  check(focusdesk::snapshotTextBounds(snapshot.commands[0]));
  check(focusdesk::snapshotTextBounds(snapshot.commands[1]));
  image.clear();
  panel.calls.clear();
  focusdesk::drawDisplaySnapshot(panel, snapshot);
  check(panel.update() && image.size() == 30000);

  std::vector<uint8_t> expected(400 * 300, 1);
  size_t inkPixels = 0;
  for (const auto& textCommand : snapshot.commands) {
    const auto* font = focusdesk::displaySnapshotFont(textCommand.a);
    int cursor = textCommand.x;
    for (const auto c : textCommand.text) {
      const auto& glyph = font->glyph[static_cast<unsigned char>(c) - font->first];
      for (int y = 0; y < glyph.height; ++y) {
        for (int x = 0; x < glyph.width; ++x) {
          const size_t bit = static_cast<size_t>(y) * glyph.width + x;
          if (font->bitmap[glyph.bitmapOffset + bit / 8] & (0x80 >> (bit % 8))) {
            const size_t pixel = static_cast<size_t>(textCommand.y + glyph.yOffset + y) * 400 + cursor + glyph.xOffset + x;
            expected[pixel] = 0;
            ++inkPixels;
          }
        }
      }
      cursor += glyph.xAdvance;
    }
  }
  check(inkPixels > 0);
  bool pixelsMatch = true;
  for (size_t pixel = 0; pixel < expected.size(); ++pixel) {
    const auto actual = (image[pixel / 4] >> (6 - pixel % 4 * 2)) & 3;
    if (actual != expected[pixel]) { pixelsMatch = false; break; }
  }
  check(pixelsMatch);
  rejected(scene("[[1,0,0,3,0,\"A\"]]"));
  rejected(scene("[[1,0,299,4,0,\"g\"]]"));
  rejected(scene("[[1,399,40,3,0,\"W\"]]"));
  rejected(scene("[[1,399,40,4,0,\"W\"]]"));
  rejected(scene("[[1,16,40,-1,0,\"Body\"]]"));
  rejected(scene("[[1,16,40,4.0,0,\"Title\"]]"));

  check(focusdesk::displaySnapshotFont(5) == &SourceSans3Regular9pt7b);
  check(focusdesk::displaySnapshotFont(6) == &SourceSans3Bold9pt7b);
  check(focusdesk::displaySnapshotFont(7) == &SourceSans3Bold18pt7b);
  check(focusdesk::displaySnapshotFont(8) == &SourceSans3Regular12pt7b);
  check(focusdesk::displaySnapshotFont(9) == &SourceSans3Bold12pt7b);
  const auto sourceSans = scene(
      "[[1,16,32,5,0,\"Readable task\"],[1,16,65,6,0,\"FocusDesk\"],"
      "[1,16,112,7,0,\"Large title\"],[1,16,155,8,0,\"Empty day\"],"
      "[1,16,195,9,0,\"Daily overview\"]]");
  check(focusdesk::parseDisplaySnapshot(sourceSans.data(), sourceSans.size(), snapshot, error));
  check(error == nullptr && snapshot.commands.size() == 5);
  for (size_t i = 0; i < snapshot.commands.size(); ++i) {
    check(snapshot.commands[i].a == static_cast<int>(i) + 5);
    check(focusdesk::snapshotTextBounds(snapshot.commands[i]));
  }
  image.clear();
  panel.calls.clear();
  focusdesk::drawDisplaySnapshot(panel, snapshot);
  check(panel.update() && image.size() == 30000);

  expected.assign(400 * 300, 1);
  inkPixels = 0;
  for (const auto& textCommand : snapshot.commands) {
    const auto* font = focusdesk::displaySnapshotFont(textCommand.a);
    int cursor = textCommand.x;
    for (const auto c : textCommand.text) {
      const auto& glyph = font->glyph[static_cast<unsigned char>(c) - font->first];
      for (int y = 0; y < glyph.height; ++y) {
        for (int x = 0; x < glyph.width; ++x) {
          const size_t bit = static_cast<size_t>(y) * glyph.width + x;
          if (font->bitmap[glyph.bitmapOffset + bit / 8] & (0x80 >> (bit % 8))) {
            const size_t pixel = static_cast<size_t>(textCommand.y + glyph.yOffset + y) * 400 + cursor + glyph.xOffset + x;
            expected[pixel] = 0;
            ++inkPixels;
          }
        }
      }
      cursor += glyph.xAdvance;
    }
  }
  check(inkPixels > 0);
  pixelsMatch = true;
  for (size_t pixel = 0; pixel < expected.size(); ++pixel) {
    const auto actual = (image[pixel / 4] >> (6 - pixel % 4 * 2)) & 3;
    if (actual != expected[pixel]) { pixelsMatch = false; break; }
  }
  check(pixelsMatch);
  for (int font = 5; font <= 9; ++font) {
    const auto index = std::to_string(font);
    rejected(scene("[[1,0,0," + index + ",0,\"A\"]]"));
    rejected(scene("[[1,0,299," + index + ",0,\"g\"]]"));
    rejected(scene("[[1,399,40," + index + ",0,\"W\"]]"));
  }
  rejected(scene("[[1,16,40,9.0,0,\"Title\"]]"));
  const GFXfont* roundedFonts[] = {&NunitoRegular10px, &NunitoBold10px, &NunitoRegular11px, &NunitoBold11px,
      &NunitoRegular13px, &NunitoRegular16px, &NunitoBold16px, &NunitoBold17px};
  std::string roundedCommands = "[";
  for (int index = 0; index < 8; ++index) {
    check(focusdesk::displaySnapshotFont(index + 10) == roundedFonts[index]);
    if (index) roundedCommands += ',';
    roundedCommands += "[1,16," + std::to_string(30 + index * 30) + ',' + std::to_string(index + 10) + ",0,\"Nunito round\"]";
  }
  roundedCommands += ']';
  const auto rounded = scene(roundedCommands);
  check(focusdesk::parseDisplaySnapshot(rounded.data(), rounded.size(), snapshot, error));
  check(snapshot.commands.size() == 8);
  image.clear();
  panel.calls.clear();
  focusdesk::drawDisplaySnapshot(panel, snapshot);
  check(panel.update() && image.size() == 30000);
  expected.assign(400 * 300, 1);
  for (const auto& textCommand : snapshot.commands) {
    const auto* font = focusdesk::displaySnapshotFont(textCommand.a);
    int cursor = textCommand.x;
    for (const unsigned char character : textCommand.text) {
      const auto& glyph = font->glyph[character - font->first];
      for (int y = 0; y < glyph.height; ++y) {
        for (int x = 0; x < glyph.width; ++x) {
          const size_t bit = static_cast<size_t>(y) * glyph.width + x;
          if (font->bitmap[glyph.bitmapOffset + bit / 8] & (0x80 >> (bit % 8))) {
            expected[static_cast<size_t>(textCommand.y + glyph.yOffset + y) * 400 + cursor + glyph.xOffset + x] = 0;
          }
        }
      }
      cursor += glyph.xAdvance;
    }
  }
  pixelsMatch = true;
  for (size_t pixel = 0; pixel < expected.size(); ++pixel) {
    if (((image[pixel / 4] >> (6 - pixel % 4 * 2)) & 3) != expected[pixel]) { pixelsMatch = false; break; }
  }
  check(pixelsMatch);
  for (int font = 10; font <= 17; ++font) {
    const auto index = std::to_string(font);
    rejected(scene("[[1,0,0," + index + ",0,\"A\"]]"));
    rejected(scene("[[1,0,299," + index + ",0,\"g\"]]"));
    rejected(scene("[[1,399,40," + index + ",0,\"W\"]]"));
  }
  rejected(scene("[[1,16,40,17.0,0,\"Title\"]]"));
  std::cout << "PASS: " << checks << " V0.2 snapshot checks\n";
}

int main(int argc, char** argv) {
  if (argc == 1) { selfTest(); return 0; }
  if (argc != 3) { std::cerr << "Usage: v02-snapshot [scene.json pixels.raw]\n"; return 2; }
  std::ifstream input(argv[1], std::ios::binary);
  check(input.good());
  const std::string body{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  focusdesk::DisplaySnapshot snapshot;
  const char* error = nullptr;
  if (!focusdesk::parseDisplaySnapshot(body.data(), body.size(), snapshot, error)) {
    std::cerr << "Rejected scene: " << error << '\n'; return 1;
  }
  check(focusdesk_config::boundedHubJson(body.data(), body.size(), 768));
  GDEM042F52Display display;
  check(display.begin());
  focusdesk::drawDisplaySnapshot(display, snapshot);
  check(display.update() && image.size() == 30000);
  std::ofstream output(argv[2], std::ios::binary);
  check(output.good());
  for (size_t pixel = 0; pixel < 400 * 300; ++pixel) {
    output.put(static_cast<char>((image[pixel / 4] >> (6 - pixel % 4 * 2)) & 3));
  }
  output.close(); check(output.good());
  std::cout << "PASS: 400x300 raw color indexes captured from driver framebuffer\n";
}
