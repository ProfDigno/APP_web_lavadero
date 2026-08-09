do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'comisiones_diarias' and column_name = 'total_vales'
  ) then
    alter table comisiones_diarias add column total_vales numeric(12,2) not null default 0;
  end if;
end $$;

create table if not exists vales_personal (
  id serial primary key,
  personal_id integer not null references personal(id),
  fecha_pago date not null,
  monto numeric(12,2) not null default 0,
  forma_pago_id integer not null references formas_pago(id),
  estado varchar(20) not null default 'EMITIDO' check (estado in ('EMITIDO', 'ANULADO')),
  creado_en timestamp not null default now(),
  creado_por varchar(120) not null,
  anulado_en timestamp,
  anulado_por varchar(120)
);

create index if not exists vales_personal_fecha_personal_idx
  on vales_personal (fecha_pago, personal_id);
