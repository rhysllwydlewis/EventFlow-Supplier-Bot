# Evidence and Provenance

The bot does not retain full supplier websites as its long-term evidence model. It stores bounded evidence fragments containing the source URL, observed timestamp, SHA-256 content hash, a small excerpt and metadata.

Candidate facts and later AI outputs must refer back to evidence. Unsupported facts are omitted rather than inferred. Claimed supplier edits will later take precedence over bot observations; the bot can continue to record website discrepancies without overwriting supplier-managed fields.
