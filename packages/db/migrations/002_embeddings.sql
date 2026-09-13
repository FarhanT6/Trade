-- Optional pgvector store for post/narrative embeddings (spec §14 "Embeddings").
do $$
begin
  begin
    create extension if not exists vector;
  exception when others then
    raise notice 'pgvector not available; skipping embeddings table';
    return;
  end;
  execute 'create table if not exists post_embeddings (post_id text primary key references social_posts(id) on delete cascade, embedding vector(512) not null, model text not null)';
  execute 'create index if not exists post_embeddings_idx on post_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100)';
end $$;
