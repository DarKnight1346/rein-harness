# Playbook: Java 8 / 11 / 17 → Java 21

Plan mode is on. Plan the upgrade as phases that each build, pass the tests and can ship alone. Don't modernize code style in the same step as making it compile.

## 1. Where it stands

- The current version: `maven.compiler.release` / `source` / `target`, Gradle `toolchain` / `sourceCompatibility`, `.java-version`, `.tool-versions`, CI images, Dockerfiles (`FROM eclipse-temurin:…`).
- Build tool and plugin versions (Maven compiler/surefire/failsafe, Gradle wrapper). Gradle needs 8.5+ to run on 21; Lombok 1.18.30+, Mockito 5, ByteBuddy 1.14+, Spring Boot 3.2+ (which itself needs Jakarta EE 9+ and Spring 6), Hibernate 6, Jackson 2.15+.
- What it uses that's gone: run `jdeps --jdk-internals` on the jars and search for `javax.xml.bind`, `javax.activation`, `javax.annotation`, `javax.xml.ws`, CORBA, `sun.misc.Unsafe`, `sun.*` / `com.sun.*` internals, `SecurityManager`, `Thread.stop/suspend/resume`, `finalize()`, Nashorn (`ScriptEngineManager` with "nashorn"), the `javax.*` → `jakarta.*` move if going to Spring Boot 3 / Jakarta EE 9+.
- Reflection into JDK internals (strong encapsulation since 17): `--add-opens` flags, `setAccessible` on JDK classes.

Prefer **OpenRewrite** (`org.openrewrite.java.migrate.UpgradeToJava21`, and `UpgradeSpringBoot_3_2` if relevant) for the mechanical parts when the build can take the plugin; check its result like any codemod.

## 2. Phases

1. **Build on 21, target the old version**: toolchain 21 with `release` still at the old level; upgrade the build tool and plugins until it compiles and tests pass.
2. **Dependencies**: upgrade libraries that break on 21 (the list above), one group at a time. Add replacements for removed modules (`jakarta.xml.bind-api` + runtime, `jakarta.annotation-api`…).
3. **Removed and encapsulated APIs**: replace internals and removed APIs; remove `--add-opens` where possible.
4. **Target 21**: set `release` to 21; update CI, Docker base images and runtime images; check GC and JVM flags (CMS is gone; `-XX:+UseG1GC` is the default; removed flags fail the JVM at start).
5. **Optional, separate PRs**: records for data carriers, pattern matching for `instanceof` and `switch`, text blocks, `var` where it reads better, virtual threads for blocking I/O servers (measure; watch `synchronized` pinning and ThreadLocal-heavy code), sequenced collections.

Each phase: what changes, how it's verified (full build, tests, a smoke run of the app on 21), and how it rolls back. Milestones per phase, then `present_plan`.
