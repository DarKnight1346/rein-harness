import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {isMigration, lintMigration, migrationNote} from '../src/contracts/migrations.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'rein-mig-')));
const risks = (file: string, text: string) => lintMigration(root, file, text).map((f) => `${f.line} ${f.risk}`);

describe('schema migration safety', () => {
  it('knows migration files', () => {
    expect(['db/migrations/0042_split.sql', 'db/migrate/20240101_add_total.rb', 'shop/migrations/0003_order.py', 'alembic/versions/ab12_add.py', 'sql/V3__orders.sql', 'migrations/001.up.sql', 'src/app.ts', 'shop/migrations/__init__.py'].map(isMigration)).toEqual([true, true, true, true, true, true, false, false]);
  });

  it('SQL: locks, backfills, irreversible steps and renames, with safe forms left alone', () => {
    const sql = `-- add the totals
ALTER TABLE orders ADD COLUMN total_cents bigint NOT NULL;
ALTER TABLE orders ADD COLUMN region text NOT NULL DEFAULT 'eu';
CREATE INDEX orders_region ON orders (region);
CREATE INDEX CONCURRENTLY orders_total ON orders (total_cents);
ALTER TABLE orders ALTER COLUMN note TYPE varchar(500);
ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE orders ADD CONSTRAINT fk_shop FOREIGN KEY (shop_id) REFERENCES shops (id) NOT VALID;
ALTER TABLE orders RENAME COLUMN total TO total_old;
UPDATE orders SET total_cents = total * 100;
UPDATE orders SET region = 'us' WHERE id < 1000;
ALTER TABLE orders DROP COLUMN legacy;
`;
    expect(risks('db/migrations/0042.sql', sql)).toEqual(['2 backfill', '4 lock', '6 lock', '7 lock', '9 breaks-running-code', '10 backfill', '12 irreversible']);
    expect(risks('db/migrations/0042.down.sql', 'DROP TABLE orders;')).toEqual([]);
  });

  it('Rails, Django and Alembic', () => {
    expect(risks('db/migrate/1_x.rb', 'class X < ActiveRecord::Migration[7.1]\n  def change\n    add_column :orders, :total, :integer, null: false\n    add_column :orders, :region, :string, null: false, default: "eu"\n    add_index :orders, :region\n    add_index :orders, :total, algorithm: :concurrently\n    rename_column :orders, :total, :amount\n  end\nend')).toEqual(['3 backfill', '5 lock', '7 breaks-running-code']);
    const django = "from django.db import migrations, models\n\nclass Migration(migrations.Migration):\n    operations = [\n        migrations.AddField(\n            model_name='order',\n            name='total',\n            field=models.IntegerField(),\n        ),\n        migrations.AddField(\n            model_name='order',\n            name='note',\n            field=models.TextField(null=True),\n        ),\n        migrations.RemoveField(model_name='order', name='legacy'),\n    ]\n";
    expect(risks('shop/migrations/0003_order.py', django)).toEqual(['5 backfill', '15 irreversible']);
    const alembic = "def upgrade():\n    op.add_column('orders', sa.Column('total', sa.Integer(), nullable=False))\n    op.create_index('ix_region', 'orders', ['region'])\n    op.create_index('ix_total', 'orders', ['total'], postgresql_concurrently=True)\n\n\ndef downgrade():\n    pass\n";
    expect(risks('alembic/versions/ab12_add.py', alembic)).toEqual(['2 backfill', '3 lock', '1 irreversible']);
  });

  it('flags up migrations without a way back, and writes the note for the agent', () => {
    mkdirSync(path.join(root, 'migrations'), {recursive: true});
    writeFileSync(path.join(root, 'migrations/002.up.sql'), 'CREATE TABLE x (id int);');
    expect(risks('migrations/002.up.sql', 'CREATE TABLE x (id int);')).toEqual(['1 irreversible']);
    writeFileSync(path.join(root, 'migrations/002.down.sql'), 'DROP TABLE x;');
    expect(risks('migrations/002.up.sql', 'CREATE TABLE x (id int);')).toEqual([]);
    expect(risks('migrations/003.sql', '-- +goose Up\nCREATE TABLE y (id int);\n-- +goose Down\n')).toEqual(['1 irreversible']);
    expect(migrationNote(lintMigration(root, 'db/migrations/1.sql', 'CREATE INDEX i ON t (c);'))).toMatch(/^The migrations you wrote have risks on a live database:\n  db\/migrations\/1\.sql:1  \[locks\] creates an index without CONCURRENTLY[\s\S]*instead: CREATE INDEX CONCURRENTLY/);
    expect(migrationNote([])).toBeUndefined();
  });
});
