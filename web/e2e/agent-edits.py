# The demo agent's edits to the FastAPI template for web/e2e/agent-session.sh: items get a priority, end to end.
import re, sys, pathlib
root = pathlib.Path(sys.argv[1]); step = sys.argv[2]
def edit(path, old, new):
    p = root / path; s = p.read_text()
    assert old in s, (path, old[:40]); p.write_text(s.replace(old, new, 1))
if step == 'models':
    edit('backend/app/models.py', '    description: str | None = Field(default=None, max_length=255)\n\n\n# Properties to receive on item creation',
         '    description: str | None = Field(default=None, max_length=255)\n    priority: int = Field(default=0, ge=0, le=3)\n\n\n# Properties to receive on item creation')
    edit('backend/app/models.py', '    description: str | None = Field(default=None, max_length=255)\n\n\n# Database model',
         '    description: str | None = Field(default=None, max_length=255)\n    priority: int | None = Field(default=None, ge=0, le=3)\n\n\n# Database model')
elif step == 'migration':
    p = root / 'backend/app/alembic/versions/b7c1e2d3f4a5_add_item_priority.py'
    p.write_text('''"""Add a priority to items

Revision ID: b7c1e2d3f4a5
Revises: 1a31ce608336
"""
import sqlalchemy as sa
from alembic import op

revision = "b7c1e2d3f4a5"
down_revision = "1a31ce608336"


def upgrade():
    op.add_column("item", sa.Column("priority", sa.Integer(), nullable=False, server_default="0"))


def downgrade():
    op.drop_column("item", "priority")
''')
elif step == 'crud':
    edit('backend/app/crud.py', '    session.refresh(db_item)\n    return db_item\n',
         '    session.refresh(db_item)\n    return db_item\n\n\ndef items_by_priority(*, session: Session, owner_id: uuid.UUID | None, skip: int, limit: int) -> list[Item]:\n    statement = select(Item)\n    if owner_id:\n        statement = statement.where(Item.owner_id == owner_id)\n    statement = statement.order_by(col(Item.priority).desc(), col(Item.created_at).desc())\n    return list(session.exec(statement.offset(skip).limit(limit)).all())\n')
    edit('backend/app/crud.py', 'from sqlmodel import Session, select', 'from sqlmodel import Session, col, select')
elif step == 'route':
    edit('backend/app/api/routes/items.py', 'skip: int = 0, limit: int = 100\n) -> Any:',
         'skip: int = 0, limit: int = 100,\n    by_priority: bool = False,\n) -> Any:')
    edit('backend/app/api/routes/items.py', '    items_public = [ItemPublic.model_validate(item) for item in items]',
         '    if by_priority:\n        owner = None if current_user.is_superuser else current_user.id\n        items = crud.items_by_priority(session=session, owner_id=owner, skip=skip, limit=limit)\n    items_public = [ItemPublic.model_validate(item) for item in items]')
    edit('backend/app/api/routes/items.py', 'from app.api.deps import', 'from app import crud\nfrom app.api.deps import')
elif step == 'types':
    s = (root / 'frontend/src/client/types.gen.ts').read_text()
    s = s.replace('export type ItemCreate = {\n    /**\n     * Title\n     */\n    title: string;', 'export type ItemCreate = {\n    /**\n     * Title\n     */\n    title: string;\n    /**\n     * Priority, 0 to 3\n     */\n    priority?: number;', 1)
    s = s.replace('export type ItemPublic = {\n    /**\n     * Title\n     */\n    title: string;', 'export type ItemPublic = {\n    /**\n     * Title\n     */\n    title: string;\n    /**\n     * Priority, 0 to 3\n     */\n    priority: number;', 1)
    (root / 'frontend/src/client/types.gen.ts').write_text(s)
elif step == 'sdk':
    edit('frontend/src/client/sdk.gen.ts', '    public static readItems<ThrowOnError extends boolean = true>(options?: Options<itemsReadItemsData, ThrowOnError>) {',
         '    public static readItems<ThrowOnError extends boolean = true>(options?: Options<itemsReadItemsData, ThrowOnError>) {\n        // by_priority sorts the most urgent first\n        options = { ...options, query: { by_priority: true, ...options?.query } } as typeof options;')
elif step == 'page':
    edit('frontend/src/routes/_layout/items.tsx', '(await ItemsService.readItems({ query: { skip: 0, limit: 100 } })).data,\n    queryKey: ["items"],',
         '(await ItemsService.readItems({ query: { skip: 0, limit: 100, by_priority: true } })).data,\n    queryKey: ["items", "by-priority"],')
elif step == 'form':
    edit('frontend/src/components/Items/AddItem.tsx', '  description: z.string().optional(),\n})',
         '  description: z.string().optional(),\n  priority: z.coerce.number().int().min(0).max(3).default(0),\n})')
elif step == 'columns':
    edit('frontend/src/components/Items/columns.tsx', 'function CopyId({ id }: { id: string }) {',
         'const PRIORITY = ["low", "normal", "high", "urgent"]\n\nfunction PriorityCell({ priority }: { priority: number }) {\n  return <span className="text-muted-foreground">{PRIORITY[priority] ?? "normal"}</span>\n}\n\nfunction CopyId({ id }: { id: string }) {')
