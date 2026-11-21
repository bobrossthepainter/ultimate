/** @jsxImportSource @solidjs/web */
import { ListChecks } from '@lucide/solid'
import { For, Show } from 'solid-js'
import { Tool, ToolContent, ToolHeader, ToolOutput } from '@/components/ai/tool.solid.tsx'
import {
  defineWebExtension,
  plural,
  useToolDuration,
  type SolidToolProps,
  type ToolCallView,
} from '@/sdk/solid'

interface Details {
  roots: string[]
  files: number
  fixed: boolean
  format: number
  lint: number
  types: number
}

const tail = (path: string) => path.split('/').slice(-3).join('/')
const detailsOf = (call: ToolCallView) => call.details as Details | undefined

function Counts(props: { details: Details }) {
  const counts = () =>
    (
      [
        ['format', props.details.format],
        ['lint', props.details.lint],
        ['type', props.details.types],
      ] as const
    ).filter(([, count]) => count)
  return (
    <Show when={counts().length} fallback={<span class="text-success">clean</span>}>
      <For each={counts()}>
        {([label, count]) => (
          <span class="text-error">
            {plural(count, label === 'type' ? 'type error' : `${label} issue`)}
          </span>
        )}
      </For>
    </Show>
  )
}

function CheckCall(props: SolidToolProps) {
  const duration = useToolDuration(() => props.call)
  const paths = () =>
    Array.isArray(props.call.args.paths) ? props.call.args.paths.map(String) : []
  return (
    <Show
      when={props.call.status !== 'error' && props.call.status !== 'interrupted'}
      fallback={props.core}
    >
      <Tool>
        <ToolHeader
          aria-label={`Check extensions #${props.call.id}`}
          icon={ListChecks}
          meta={
            <>
              <Show when={detailsOf(props.call)}>
                {(details) => (
                  <>
                    <Counts details={details()} />
                    <span>{plural(details().files, 'file')}</span>
                  </>
                )}
              </Show>
              <Show when={duration()}>
                <span>{duration()}</span>
              </Show>
            </>
          }
          name="Check extensions"
          state={props.call.status}
          title={paths().map(tail).join(', ')}
        />
        <ToolContent>
          <ToolOutput output={props.call.output} />
        </ToolContent>
      </Tool>
    </Show>
  )
}

export default defineWebExtension({ tools: { check_extensions: CheckCall } })
