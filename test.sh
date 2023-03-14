#!/bin/sh

set -eu

if [ "$(uname -s)" = "Linux" ]
then
  DLL=so
else
  DLL=dylib
fi

echo $DLL
