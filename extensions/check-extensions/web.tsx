import { ListChecksIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai/tool'
import { defineWebExtension, plural, useToolDuration } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** `CheckDetails` in server.ts. */
interface Details {
  roots: string[]
  files: number
  fixed: boolean
  format: number
  lint: number
  types: number
}

const tail = (path: string) => path.split('/').slice(-3).join('/')

/** One `check_extensions` call: what was checked, and a count per failing check or "clean". */
function CheckCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const duration = useToolDuration(call)
  if (call.status === 'error' || call.status === 'interrupted') return core
  const details = call.details as Details | undefined
  const paths = Array.isArray(call.args.paths) ? call.args.paths.map(String) : []
  const counts = details
    ? (
        [
          ['format', details.format],
          ['lint', details.lint],
          ['type', details.types],
        ] as const
      ).filter(([, count]) => count)
    : []
  return (
    <Tool>
      <ToolHeader
        icon={ListChecksIcon}
        meta={
          <>
            {details &&
              (counts.length ? (
                counts.map(([label, count]) => (
                  <span className="text-error" key={label}>
                    {plural(count, label === 'type' ? 'type error' : `${label} issue`)}
                  </span>
                ))
              ) : (
                <span className="text-success">clean</span>
              ))}
            {details && <span>{plural(details.files, 'file')}</span>}
            {duration && <span>{duration}</span>}
          </>
        }
        name="Check extensions"
        state={call.status}
        title={paths.map(tail).join(', ')}
      />
      <ToolContent>
        <ToolOutput output={call.output} />
      </ToolContent>
    </Tool>
  )
}

export default defineWebExtension({ tools: { check_extensions: CheckCall } })
