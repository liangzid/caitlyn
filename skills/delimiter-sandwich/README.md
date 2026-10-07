# Delimiter Sandwich Preprocessor

## Status

Experimental knowledge entry. It is not executed as a standalone preprocessor by the current scanner.

## Purpose

Specifies how untrusted content should be escaped and wrapped so it cannot close its container or introduce a forged role or sibling instruction block.

## Intended execution

Generate an unpredictable delimiter, escape matching content, wrap the data and place the data-handling rule in a trusted instruction channel.

## Limitations

Static XML or Markdown delimiters do not establish a security boundary by themselves. The model and adapter must preserve the separation end to end.
