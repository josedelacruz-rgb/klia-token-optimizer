/**
 * Plugin de opencode: klia-auto-record
 *
 * Cierra el bucle del router adaptativo klia-token-optimizer registrando
 * automaticamente las metricas reales (tokens, latencia, coste) de cada
 * tarea despues de que el asistente termine de responder.
 *
 * Ademas, muestra feedback visual en pantalla (toasts y mensajes en el chat)
 * para que el usuario vea cuando klia-token-optimizer esta trabajando, que
 * optimizador eligio y cuanto ahorro.
 *
 * Como funciona:
 *   1. Intercepta las llamadas a la herramienta route_task del MCP
 *      klia-token-optimizer para capturar sessionId, optimizer, model, query.
 *   2. Muestra un toast y un mensaje en el chat con la decision del router.
 *   3. Cuando la sesion pasa a idle (el asistente termino), suma los tokens
 *      de todos los mensajes del asistente posteriores a la llamada route_task.
 *   4. Invoca el CLI del router con --record-execution para persistir la
 *      ejecucion con metricas reales en events.json e history.json.
 *   5. Muestra un toast de resumen con tokens, latencia y coste estimado.
 */

import type { Plugin } from "@opencode-ai/plugin"

// Ruta al CLI del router. Se puede sobreescriir con la variable de entorno
// KLIA_ROUTER_CLI_PATH. Por defecto apunta a la instalacion estandar en
// %LOCALAPPDATA%\klia-token-optimizer\dist\router-cli.js
function getRouterCliPath(): string {
  if (process.env.KLIA_ROUTER_CLI_PATH) return process.env.KLIA_ROUTER_CLI_PATH
  const localAppData = process.env.LOCALAPPDATA ?? ""
  // Instalacion estandar en Windows
  const winPath = `${localAppData}/klia-token-optimizer/dist/router-cli.js`
  return winPath
}

// Estructura para recordar la ultima decision de route_task por sesion
interface RouteDecision {
  sessionId: string | undefined
  optimizer: string
  model: string
  query: string
  taskType: string
  confidence: number
  version: string
  reason: string
  timestamp: number
}

// Mapa: sessionID -> ultima decision de route_task pendiente de registrar
const pendingDecisions = new Map<string, RouteDecision>()

// Flag para no registrar dos veces la misma sesion
const recordedSessions = new Set<string>()

// Acumulador de ahorro por sesion para el resumen final
interface SessionSavings {
  tokensUsed: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  tasksRouted: number
  optimizersUsed: string[]
}
const sessionSavings = new Map<string, SessionSavings>()

/**
 * Muestra un toast en opencode (notificacion temporal).
 * Sigue el patron de DCP: client.tui.showToast().
 */
async function showToast(client: any, title: string, message: string, variant: "info" | "warning" | "success" = "info", duration = 5000): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title, message, variant, duration },
    })
  } catch {
    // Silenciar: el toast no debe romper el flujo
  }
}

/**
 * Inyecta un mensaje en el chat del usuario (visible pero no genera respuesta del modelo).
 * Sigue el patron de DCP sendIgnoredMessage(): client.session.prompt() con noReply+ignored.
 */
async function injectChatMessage(client: any, sessionID: string, text: string): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: sessionID },
      body: {
        noReply: true,
        parts: [{ type: "text", text, ignored: true }],
      },
    })
  } catch {
    // Silenciar: el mensaje inyectado no debe romper el flujo
  }
}

/**
 * Formatea un numero de tokens de forma legible.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Formatea un coste en USD de forma legible.
 */
function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(5)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

export const KliaAutoRecord: Plugin = async ({ client, $ }) => {
  const routerCliPath = getRouterCliPath()

  return {
    // Capturar llamadas a route_task del MCP klia-token-optimizer
    "tool.execute.after": async (input, output) => {
      try {
        const toolName: string = input.tool ?? ""
        // El nombre de la herramienta en opencode sigue el patron:
        //   klia-token-optimizer_route_task
        // o en algunos entornos:
        //   mcp__klia-token-optimizer__route_task
        if (!toolName.includes("route_task")) return

        // Los argumentos de entrada estan en output.args o en input.args
        const args = output?.args ?? input?.args ?? {}
        const model: string = args.model ?? ""
        const query: string = args.query ?? ""
        if (!model || !query) return

        // El resultado de route_task es JSON con optimizer, sessionId, taskType, etc.
        // Puede estar en output.output (string) o en output.result
        let resultText = ""
        if (typeof output?.output === "string") {
          resultText = output.output
        } else if (typeof output?.result === "string") {
          resultText = output.result
        } else if (output?.output?.text) {
          resultText = output.output.text
        } else if (typeof output === "string") {
          resultText = output
        }

        // Extraer el JSON del resultado (puede venir envuelto en estructura MCP)
        let optimizer = "BASELINE"
        let sessionId: string | undefined
        let taskType = "SMALL_CODE"
        let confidence = 0
        let version = "V0"
        let reason = ""

        try {
          // Intentar parsear el texto como JSON
          const parsed = JSON.parse(resultText)
          optimizer = parsed.optimizer ?? optimizer
          sessionId = parsed.sessionId ?? sessionId
          taskType = parsed.taskType ?? taskType
          confidence = parsed.confidence ?? confidence
          version = parsed.version ?? version
          reason = parsed.reason ?? reason
        } catch {
          // Si no es JSON, intentar extraer campos con regex
          const optMatch = resultText.match(/"optimizer"\s*:\s*"([^"]+)"/)
          if (optMatch) optimizer = optMatch[1]
          const sidMatch = resultText.match(/"sessionId"\s*:\s*"([^"]+)"/)
          if (sidMatch) sessionId = sidMatch[1]
          const ttMatch = resultText.match(/"taskType"\s*:\s*"([^"]+)"/)
          if (ttMatch) taskType = ttMatch[1]
          const confMatch = resultText.match(/"confidence"\s*:\s*([\d.]+)/)
          if (confMatch) confidence = parseFloat(confMatch[1])
          const verMatch = resultText.match(/"version"\s*:\s*"([^"]+)"/)
          if (verMatch) version = verMatch[1]
        }

        const sessionID: string = input.sessionID ?? input.sessionId ?? ""
        if (!sessionID) return

        pendingDecisions.set(sessionID, {
          sessionId,
          optimizer,
          model,
          query,
          taskType,
          confidence,
          version,
          reason,
          timestamp: Date.now(),
        })

        // Inicializar acumulador de sesion
        const savings = sessionSavings.get(sessionID) ?? {
          tokensUsed: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          tasksRouted: 0,
          optimizersUsed: [],
        }
        savings.tasksRouted++
        if (!savings.optimizersUsed.includes(optimizer)) {
          savings.optimizersUsed.push(optimizer)
        }
        sessionSavings.set(sessionID, savings)

        // Limpiar el flag de "ya registrado" para esta sesion
        recordedSessions.delete(sessionID)

        // === FEEDBACK VISUAL ===
        // Toast con la decision del router
        const confPct = Math.round(confidence * 100)
        const toastMsg = `${optimizer} | ${taskType} | confianza ${confPct}%`
        await showToast(client, "klia-token-optimizer", toastMsg, "info", 4000)

        // Mensaje inyectado en el chat (visible, no genera respuesta del modelo)
        const chatMsg = `\u25A3 klia-token-optimizer | ${optimizer} | ${taskType} | ${version} | confianza ${confPct}%`
        await injectChatMessage(client, sessionID, chatMsg)
      } catch {
        // Silenciar errores: el plugin no debe romper opencode
      }
    },

    // Escuchar eventos de sesion para detectar cuando el asistente termina
    event: async ({ event }) => {
      try {
        if (event.type !== "session.idle") return

        const sessionID: string = event.properties?.sessionID ?? ""
        if (!sessionID) return

        const decision = pendingDecisions.get(sessionID)
        if (!decision) return
        if (recordedSessions.has(sessionID)) return

        // Obtener los mensajes de la sesion para sumar tokens
        const messagesResponse = await client.session.messages({
          path: { id: sessionID },
        })
        const messages = messagesResponse.data ?? []

        // Sumar tokens de los mensajes del asistente posteriores a route_task
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalCost = 0
        let firstCreated: number | null = null
        let lastCompleted: number | null = null

        for (const msg of messages) {
          const info = msg.info
          if (info.role !== "assistant") continue
          // Solo contar mensajes despues de la llamada a route_task
          if (info.time.created < decision.timestamp) continue

          totalInputTokens += info.tokens?.input ?? 0
          totalOutputTokens += info.tokens?.output ?? 0
          totalCost += info.cost ?? 0

          if (firstCreated === null || info.time.created < firstCreated) {
            firstCreated = info.time.created
          }
          if (info.time.completed && (lastCompleted === null || info.time.completed > lastCompleted)) {
            lastCompleted = info.time.completed
          }
        }

        // Si no hay mensajes del asistente despues de route_task, salir
        if (totalInputTokens === 0 && totalOutputTokens === 0) return

        const totalTokens = totalInputTokens + totalOutputTokens
        const latencySeconds =
          firstCreated !== null && lastCompleted !== null
            ? Math.max(1, Math.round((lastCompleted - firstCreated) / 1000))
            : 1

        // Actualizar acumulador de sesion
        const savings = sessionSavings.get(sessionID)
        if (savings) {
          savings.tokensUsed += totalTokens
          savings.inputTokens += totalInputTokens
          savings.outputTokens += totalOutputTokens
          savings.costUsd += totalCost
        }

        // Marcar como registrado antes de invocar el CLI (evita duplicados)
        recordedSessions.add(sessionID)
        pendingDecisions.delete(sessionID)

        // Invocar el CLI del router para registrar la ejecucion
        try {
          await $`node ${routerCliPath} --record-execution --model ${decision.model} --query ${decision.query} --optimizer ${decision.optimizer} --tokens ${totalTokens} --input-tokens ${totalInputTokens} --output-tokens ${totalOutputTokens} --latency ${latencySeconds} --quality 0.95 --session-id ${decision.sessionId ?? ""}`

          // === FEEDBACK VISUAL: resumen de ejecucion ===
          const costStr = totalCost > 0 ? formatUsd(totalCost) : "n/a"
          const execMsg = `\u25A3 klia-token-optimizer | registrado: ${decision.optimizer} | ${formatTokens(totalTokens)} tokens (${formatTokens(totalInputTokens)}+${formatTokens(totalOutputTokens)}) | ${latencySeconds}s | ${costStr}`
          await showToast(client, "klia-token-optimizer: ejecucion registrada", execMsg, "success", 5000)

          // Mensaje inyectado en el chat con el resumen
          await injectChatMessage(client, sessionID, execMsg)
        } catch {
          // Si falla el registro, mostrar toast de error
          await showToast(
            client,
            "klia-token-optimizer: error",
            `No se pudo registrar la ejecucion de ${decision.optimizer}`,
            "warning",
            5000,
          )
        }
      } catch {
        // Silenciar errores del plugin
      }
    },
  }
}
