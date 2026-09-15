# How people get a new Scout

Scout checks these files when someone opens it. If there is a newer version,
it offers **Update** or **Remind me later**.

| File | Who reads it | Who writes it |
| --- | --- | --- |
| `stable.json` | everyone using Scout | only the **Release to everyone** workflow |
| `beta.json` | George and Jose (Settings → Version → "Get test builds early") | every build, automatically |
| `builds/<tag>.json` | nobody directly | every build. The record of what a version contains |

## To give everyone a new version

**Actions → Release to everyone → type the tag → Run.**

That is the whole thing. A build going green does *not* reach clients; it only
lands in `beta.json`, so you can install it yourself first.

## To undo a bad release

The same button, with the **previous** version's tag.

People stop being offered the bad one within about five minutes. It cannot
take it off a computer that already updated — for that, build the fix and
release that.

## To stop everything

The same button, with **Percent = 0**. Scout reads that as "nothing
available" and says nothing to anybody.

## Why these are files and not a website

No server, so nothing to keep running and nothing to pay for. More
importantly: publishing an update never creates or edits a *release*, which
is what the old Scout 1 fleet still reads its updates from. Both workflows
check that this repository's "latest" release is still `v3.6.0` before they
finish.

Do not hand-edit these files. The tag, the file names and the checksums have
to agree, and a checksum typed by hand means every copy of Scout rejects the
download.
