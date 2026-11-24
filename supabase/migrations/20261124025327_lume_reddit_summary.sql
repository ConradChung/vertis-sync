-- GTM-15: one-line summary of the comment (Haiku), shown on the #sales card.
alter table public.signal_reddit_mentions add column if not exists summary text;
