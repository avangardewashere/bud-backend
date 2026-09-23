# Cover Check

The Docker course has no cover image, and neither did the test fixture built from
it. That is why four separate bugs in how a cover becomes a URL went unnoticed
until a review went looking: the field was always null, so nothing ever rendered
it and nothing ever fetched it.

This package exists so that stops being true. It carries one session and one
cover, and CI ingests it, publishes it, and fetches the cover from the course
origin over real HTTP.

## The session

One worksheet, which saves a single value through the bridge so the package is a
real course rather than a page with a picture attached.
