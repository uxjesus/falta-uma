# Servidor do backup automático do Playset

Worker da Cloudflare que guarda uma cópia dos decks. Só aceita quem tem a chave (segredo `SYNC_TOKEN`, definido no painel da Cloudflare, nunca neste repositório).
O armazenamento (KV `playset-backup`) está declarado em `wrangler.jsonc`.
