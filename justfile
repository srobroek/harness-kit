# Task runner. `just verify` is the CI gate; ci.yml runs the same steps through bun directly.
set shell := ["sh", "-cu"]

default:
    @just --list

install:
    bun install --frozen-lockfile

test:
    bun run test

typecheck:
    bun run typecheck

pack-check:
    bun run pack-check

verify: install test typecheck pack-check
