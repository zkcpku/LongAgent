# Prompt

## Objective
Build a production-grade, full-featured C compiler in Rust with a robust architecture and extensible multi-backend design.

## Constraints
- Prefer correctness and maintainability first, then optimize performance.
- Keep commits small and reversible.
- Every task must pass verify + acceptance gates.

## Definition Of Done
- Full compiler architecture in place: frontend, ir, passes, backend, common, driver.
- Frontend supports broad C language constructs with strong diagnostics.
- x86_64 backend can generate native ELF and run meaningful programs.
- ARM64/RISC-V paths are implemented as serious backends with clear completion path.
- ccc / ccc-arm / ccc-riscv binaries work through a consistent driver.
- Smoke tests pass (`int main() { return N; }`, simple `printf`).
- Conformance and regression suites are established.
- Performance benchmarking and optimization report is produced.
