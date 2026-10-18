#include "protocol.h"

#include <fcntl.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

namespace {

// Two decimals is a tenth of a point: finer than any display can show, and it
// keeps the line short enough that no message is ever truncated by a reader.
std::string number(double value) {
  char buffer[32];
  std::snprintf(buffer, sizeof(buffer), "%.2f", value);
  return std::string(buffer);
}

}  // namespace

void Protocol::set_nonblocking_stdout() { ::fcntl(1, F_SETFL, O_NONBLOCK); }

void Protocol::write_line_out(const std::string& line) {
  std::string framed = line;
  framed.push_back('\n');
  const char* data = framed.data();
  size_t remaining = framed.size();
  while (remaining > 0) {
    const ssize_t written = ::write(1, data, remaining);
    if (written <= 0) return;  // Pipe closed or full: drop rather than stall.
    data += written;
    remaining -= static_cast<size_t>(written);
  }
}

void Protocol::send_ready() { write_line_out("{\"type\":\"ready\",\"version\":1}"); }

void Protocol::send_wheel_open(double x, double y) {
  write_line_out("{\"type\":\"wheelOpen\",\"x\":" + number(x) + ",\"y\":" + number(y) + "}");
}

void Protocol::send_wheel_move(double x, double y) {
  write_line_out("{\"type\":\"wheelMove\",\"x\":" + number(x) + ",\"y\":" + number(y) + "}");
}

void Protocol::send_wheel_release(double x, double y) {
  write_line_out("{\"type\":\"wheelRelease\",\"x\":" + number(x) + ",\"y\":" + number(y) + "}");
}

void Protocol::send_cancel() { write_line_out("{\"type\":\"cancel\"}"); }

void Protocol::send_bye() { write_line_out("{\"type\":\"bye\"}"); }

void Protocol::send_error(const char* code, const char* message) {
  // Escape the two characters that would otherwise break the line framing.
  std::string safe;
  for (const char* p = message; p != nullptr && *p != '\0'; ++p) {
    if (*p == '"' || *p == '\\') safe.push_back('\\');
    safe.push_back(*p);
  }
  write_line_out("{\"type\":\"error\",\"code\":\"" + std::string(code) + "\",\"message\":\"" + safe + "\"}");
}