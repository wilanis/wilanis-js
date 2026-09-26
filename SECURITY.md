# Security

## Supported versions

Nothing is released yet. `main` is the only supported branch, and until 1.0 there are no published packages
to patch. Once 1.0 is cut, this section says which versions receive fixes.

## Reporting a vulnerability

Report it privately, not as an issue:

- **Preferred:** the repository's *Security* tab, *Report a vulnerability*. This opens a private advisory
  only the maintainers can read.
- **Or:** rfontes1987@gmail.com.

Please include what you found, the tree or the command that shows it, and what an attacker gets. A proof of
concept helps and is never required.

You can expect an acknowledgement, and then either a fix with an advisory or an explanation of why the
behaviour is intended. No date is promised: this is one maintainer, and a deadline that cannot be kept is
worse than none. A report that holds is worked on ahead of everything else. Tell us how you would like to be
credited, or that you would rather not be.

## Before you report

Two things look like findings and are not:

- **A plugin is arbitrary code.** The checker judges documents and how they compose; it never judges what a
  handler does once called. A plugin that misbehaves is a bug in that plugin.
- **The directories are fixtures.** `example/connections/` and `libraries/access/connections/` hold the
  development identities the trees sign in against: scrypt hashes in `settings`, and the cleartext passwords
  in each file's `description`, so the trees can be checked, rehearsed and run on their own. A production
  profile binds the same port to a real directory.

## The security model

[`docs/security-model.md`](docs/security-model.md) says what every tree `wilanis check` accepts is guaranteed,
what the runtime enforces on every run, what is left to the application, and what the model does not address.
A line under *Guaranteed by the checker* or *Enforced by the runtime* that is false is a vulnerability: it is
fixed in the code, and the advisory quotes the line. Once packages are published, the fix ships as a patch
release of every affected package. The page is never edited to match the bug. A line under *The application's*
found wanting is not a vulnerability; it is a request to move the line up, which is an RFC. What the page puts
outside the model is not a finding either; a plugin's code is outside it except where a line under *Enforced by
the runtime* names it.
