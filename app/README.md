# flai app

Mac, Windows, Linux and Android. The same idea as the web page, without the borrowed constraints.

The hosted bridge exists to squeeze BitTorrent through a 512 MB box with no disk: one file at a
time, a 32 MB sliding window, pieces discarded the moment they are sent. None of that is a
property of BitTorrent — it is a property of a free-tier server. This has a disk.

| | web | app |
|---|---|---|
| Files at once | one per torrent | all of them |
| Size limit | none, but one file at a time | none |
| Survives a restart | the URL heals itself | the session is on disk |
| Password | yes | no — it is your machine |
| Inbound peers | never (host allows none) | yes, via UPnP |

## Running it

```
npm install
npm run app        # dev window with hot reload
npm run bundle     # a real .app / .dmg in src-tauri/target/release/bundle
```

Releases for macOS, Windows, Linux and Android are built by `.github/workflows/app.yml`, on a tag:

```
git tag desktop-v1.0.0 && git push --tags
```

**The builds are not signed.** A certificate is a yearly fee and this is free, so the first
launch needs one extra step: on macOS right-click → Open, on Windows *More info* → *Run anyway*.

## What is worth knowing

**Downloading fewer files does not make them arrive faster.** It is the natural assumption and
it is backwards. BitTorrent picks the rarest pieces first, which is what keeps a swarm healthy
and a client productive; narrowing to one file takes that choice away. Enough peers doing it
[can stall a swarm outright](https://support.tixati.com/sequential_downloading). So "all files"
is the default, and **First** is an explicit tool for when you want one episode tonight — it is
labelled as making the torrent as a whole slower, because it does.

**Speed is the swarm, not the client.** Measured on the sparse 10 GB series this was built
against, via `cargo test --test peers -- --ignored`:

| | peers seen | connected |
|---|---|---|
| the magnet's own trackers | 726 | 18 |
| plus ten public trackers | 665 | 16 |
| the magnet's own trackers again | 710 | 12 |

Seven hundred peers found, a dozen reachable. Adding trackers found no one new, which is why
there is no tracker list in the code. librqbit puts no ceiling on connections either. When a
download is slow it is because the seeds are gone, and no client setting fixes that.

**FDM's reputation comes from HTTP, not BitTorrent.** Splitting a file into parallel segments is
a real trick against a single web server. A swarm is already parallel — there is nothing to
split.

## Android

Builds, installs, and downloads real files from the swarm — verified on an emulator. Two things
it does not do yet, both for the same reason:

- **Downloads pause when you leave the app.** Android suspends a backgrounded process, and
  keeping one alive needs a foreground service. The Kotlin service is written and in the
  manifest; what is missing is the call from Rust into it.
- **No "Open in a player".** Same missing link.

The first attempt made that call through `ndk_context::android_context()`, which aborted the
process three seconds after launch with SIGABRT. ndk-context is a global that something has to
populate — ndk-glue or android-activity do; Tauri and wry do neither, and grepping both for
`ndk_context` returns nothing. It could never have worked, and `panic = "abort"` in release
means it cannot be caught either. The right shape is a Tauri plugin, whose Kotlin half runs
inside the activity and already holds the Context.

Downloading itself is unaffected, and measured at 7.8 MB/s.

## Tests

```
cargo test                                     # settings: round-trip, corruption, reset
cargo test --test downloads -- --ignored       # really writes a file to disk, ~7s
cargo test --test peers -- --ignored           # the measurement above, ~2.5 min
```

The last two talk to the real swarm, which is why they are opt-in.
