// JSON-lines protocol between the desktop host and this input helper.
//
// Kept deliberately trivial: one flat object per line, no nesting on the way in,
// because the reader on the other side is a line reader and anything more would
// need a parser here for no benefit. Every message this process sends is
// self-contained, so a dropped line costs one event and never desynchronises the
// two ends.

#ifndef DSH_QUICK_HELP_PROTOCOL_H
#define DSH_QUICK_HELP_PROTOCOL_H

#include <cstdint>
#include <string>

// Writes flat JSON lines to stdout. The host reads them line by line.
class Protocol {
 public:
  // stdout is a pipe to the host: a full buffer must not block the event tap, so
  // a failed write is dropped rather than retried. A dropped position update is
  // harmless; a blocked tap would freeze input system-wide.
  void set_nonblocking_stdout();

  void send_ready();
  void send_wheel_open(double x, double y);
  void send_wheel_move(double x, double y);
  void send_wheel_release(double x, double y);
  void send_cancel();
  void send_error(const char* code, const char* message);
  void send_bye();

 private:
  // Writes one line and a newline, ignoring a short write. A dropped event costs
  // one update; a blocked one would cost the user their input.
  void write_line_out(const std::string& line);
};

#endif  // DSH_QUICK_HELP_PROTOCOL_H