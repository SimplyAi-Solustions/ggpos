import {
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table"

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
})

interface Row {
  label: string
  revenue: number
}

export function Spike({ rows }: { rows: Row[] }) {
  const table = useTable({
    features,
    columns: [
      { id: "label", accessorKey: "label", header: "Label", sortFn: "alphanumeric" },
      { id: "revenue", accessorKey: "revenue", header: "Revenue", sortFn: "basic" },
    ],
    data: rows,
    initialState: { sorting: [{ id: "revenue", desc: true }] },
  })
  return (
    <table>
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id}>
            {group.headers.map((header) => (
              <th
                key={header.id}
                aria-sort={
                  header.column.getIsSorted() === "asc"
                    ? "ascending"
                    : header.column.getIsSorted() === "desc"
                      ? "descending"
                      : "none"
                }
              >
                <button type="button" onClick={header.column.getToggleSortingHandler()}>
                  <table.FlexRender header={header} />
                </button>
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id}>
            {row.getAllCells().map((cell) => (
              <td key={cell.id}>
                <table.FlexRender cell={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
