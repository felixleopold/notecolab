#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--check|--fix]" >&2
}

ACTION="${1:---check}"
if [ "$ACTION" != "--check" ] && [ "$ACTION" != "--fix" ]; then
  usage
  exit 2
fi

EXPECTED_UID="${APP_UID:-$(id -u)}"
if [ "$EXPECTED_UID" -eq 0 ]; then
  echo "Refusing to prepare application data for UID 0; deploy as an unprivileged account." >&2
  exit 1
fi

errors=0

check_path() {
  local path="$1"
  local expected_mode="$2"
  local kind="$3"
  local actual_uid actual_mode

  if [ -L "$path" ]; then
    echo "Unsafe path: $path is a symbolic link." >&2
    errors=$((errors + 1))
    return
  fi
  if [ "$kind" = "directory" ] && [ ! -d "$path" ]; then
    echo "Unsafe path: $path is not a directory." >&2
    errors=$((errors + 1))
    return
  fi
  if [ "$kind" = "file" ] && [ ! -f "$path" ]; then
    echo "Unsafe path: $path is not a regular file." >&2
    errors=$((errors + 1))
    return
  fi

  actual_uid=$(stat -c '%u' "$path")
  actual_mode=$(stat -c '%a' "$path")
  if [ "$actual_uid" != "$EXPECTED_UID" ]; then
    echo "Unsafe owner: $path is owned by UID $actual_uid; expected deployment UID $EXPECTED_UID." >&2
    echo "Ownership is not changed automatically. Resolve it only after confirming the file belongs to this deployment." >&2
    errors=$((errors + 1))
    return
  fi

  if [ "$actual_mode" != "$expected_mode" ]; then
    if [ "$ACTION" = "--fix" ]; then
      chmod "$expected_mode" "$path"
      echo "Hardened $path to mode $expected_mode."
    else
      echo "Unsafe mode: $path is $actual_mode; expected $expected_mode." >&2
      errors=$((errors + 1))
    fi
  fi
}

if [ -e .env ] || [ -L .env ]; then
  check_path .env 600 file
fi

if [ ! -e data ]; then
  if [ "$ACTION" = "--fix" ]; then
    mkdir -m 700 data
    echo "Created data with mode 700."
  else
    echo "Missing data directory. Run $0 --fix before deploying." >&2
    errors=$((errors + 1))
  fi
fi

for root in data backups; do
  if [ ! -e "$root" ] && [ ! -L "$root" ]; then
    continue
  fi
  if [ -L "$root" ] || [ ! -d "$root" ]; then
    echo "Unsafe path: $root must be a real directory." >&2
    errors=$((errors + 1))
    continue
  fi

  while IFS= read -r -d '' path; do
    if [ -d "$path" ]; then
      check_path "$path" 700 directory
    elif [ -f "$path" ]; then
      check_path "$path" 600 file
    else
      echo "Unsafe path: $path is not a regular file or directory." >&2
      errors=$((errors + 1))
    fi
  done < <(find "$root" -print0)
done

# Historical SQLite copies have sometimes been retained beside data/. Check
# them in place, but never move, archive, or delete them automatically.
while IFS= read -r -d '' path; do
  check_path "$path" 600 file
done < <(find . -maxdepth 1 \( -type f -o -type l \) \
  \( -name '*.db' -o -name '*.db-*' -o -name '*.db.*' \
     -o -name '*.sqlite' -o -name '*.sqlite-*' -o -name '*.sqlite.*' \) \
  -print0)

if [ "$errors" -ne 0 ]; then
  echo "Permission check failed with $errors unsafe path(s); no file contents were read." >&2
  exit 1
fi

echo "Permission check passed for deployment UID $EXPECTED_UID."
