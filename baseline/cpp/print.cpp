#include "record.h"
#include <cstdio>

void printRecord(const Record& r) {
  std::printf("%d %s\n", r.id, r.title.c_str());
}
