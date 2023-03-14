#!/usr/bin/env python3

import ast
import json
import sys

if __name__ == '__main__':
  with open("node/config.gypi", encoding="utf-8") as f:
    conf = ast.literal_eval(f.read())
    json.dump(conf, sys.stdout, indent=2)
