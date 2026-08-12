do $migration$
declare
  duplicate_record record;
begin
  for duplicate_record in
    select usuario_roll_id, usuario_roll_evento_id,
           array_agg(id order by id) as ids
    from usuario_roll_item
    group by usuario_roll_id, usuario_roll_evento_id
    having count(*) > 1
  loop
    delete from usuario_roll_item
    where id = any(duplicate_record.ids[2:array_length(duplicate_record.ids, 1)]);
  end loop;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'usuario_roll_item_roll_evento_key'
      and conrelid = 'public.usuario_roll_item'::regclass
  ) then
    alter table usuario_roll_item
      add constraint usuario_roll_item_roll_evento_key
      unique (usuario_roll_id, usuario_roll_evento_id);
  end if;
end
$migration$;
