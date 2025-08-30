import "dotenv/config"
import { generateText, stepCountIs, tool } from "ai"
import { serveAgent, serveAuthedAgent } from "./serve-agent"
import { anthropic } from "@ai-sdk/anthropic"
import { z } from "zod"
import { AckLabSdk } from "@ack-lab/sdk"
import { HermesClient } from "@pythnetwork/hermes-client"
import { logger } from "./logger"

// ==================== Configuration ====================
const DECODE_JWT = process.env.DECODE_JWT !== 'false'
const SOL_USD_PRICE_ID = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"
const FALLBACK_SOL_PRICE = 150

// ==================== SDK Initialization ====================
const pythClient = new HermesClient("https://hermes.pyth.network", {})

const swapServiceSdk = new AckLabSdk({
  baseUrl: process.env.ACK_LAB_BASE_URL ?? "https://api.ack-lab.com",
  clientId: process.env.CLIENT_ID_SWAP_SERVICE || '',
  clientSecret: process.env.CLIENT_SECRET_SWAP_SERVICE || ''
})

const swapUserSdk = new AckLabSdk({
  baseUrl: process.env.ACK_LAB_BASE_URL ?? "https://api.ack-lab.com",
  clientId: process.env.CLIENT_ID_SWAP_USER || '',
  clientSecret: process.env.CLIENT_SECRET_SWAP_USER || ''
})

// ==================== Types & Storage ====================
interface PendingSwap {
  usdcAmount: number
  paymentRequestUrl: string
  solAmount: number
  exchangeRate: number
}

const pendingSwaps = new Map<string, PendingSwap>()
const completedSwaps = new Set<string>()

// ==================== System Prompts ====================
const SWAP_SERVICE_SYSTEM_PROMPT = `You are a swap agent that can exchange USDC for SOL. 
    
When asked to swap USDC for SOL:
1. First use the createSwapRequest tool to check the exchange rate and generate a payment request
2. Return the payment token in a STRUCTURED format like this:

   <payment_request_url>
   [INSERT_EXACT_PAYMENT_REQUEST_URL_HERE]
   </payment_request_url>

3. Tell the user the exchange rate and how much SOL they will receive
4. Once they confirm payment with a payment receipt (A URL), use the executeSwap tool with that receipt. NO need to ask them for their SOL address if they already provided it.

CRITICAL PAYMENT PROCESSING RULES:
- You MUST process payments for the EXACT amount requested - never partial amounts
- If a payment fails due to spending limits or insufficient funds, you MUST reject the entire transaction
- NEVER suggest, attempt, or process a smaller amount when the original payment fails
- NEVER say things like "I was able to process X amount instead" - this is strictly forbidden
- If the requested amount cannot be processed, inform the user that the transaction failed and they need to either:
  a) Increase their spending limit, or 
  b) Request a smaller swap amount from the beginning
- You are like a merchant terminal - either the full amount goes through or the transaction is declined

IMPORTANT TECHNICAL DETAILS:
- ALWAYS wrap the payment token between <payment_request_url> and </payment_request_url> markers
- The payment receipt URL you receive should also be in a structured format (between markers)
- Extract the ENTIRE content between the markers, including all characters
- The payment receipt is a URL that contains the payment token and other payment details
- The payment amount should be in cents (100 USD = 10000 cents)
- Show the exchange rate clearly to the user

For any requests that are not about swapping USDC to SOL, say 'I can only swap USDC for SOL'.`

const SWAP_USER_SYSTEM_PROMPT = `You are a user who wants to swap USDC for SOL. You have USDC and want to exchange it for SOL using the Swap Service.

The Swap Service will:
1. Give you an exchange rate and calculate how much SOL you'll receive
2. Provide a payment token in a structured format between <payment_token> and </payment_token> markers
3. Execute the swap and send you SOL after payment

When you receive a payment request:
1. Look for the payment request URL between <payment_request_url> and </payment_request_url> markers
2. Extract the ENTIRE content between these markers
3. Use the executePayment tool with that EXACT paymentRequestUrl
4. After successful payment, send the receipt back in a STRUCTURED format:

   Payment completed successfully.

   <receipt_url>
   [INSERT_FULL_RECEIPT_URL_HERE]
   </receipt_url>

   Please proceed with sending SOL to 7VQo3HWesNfBys5VXJF3NcE5JCBsRs25pAoBxD5MJYGp

Your Solana address is: 7VQo3HWesNfBys5VXJF3NcE5JCBsRs25pAoBxD5MJYGp

CRITICAL PAYMENT BEHAVIOR RULES:
- You MUST only attempt to pay the EXACT amount requested by the Swap Agent
- If a payment fails due to spending limits, insufficient funds, or any other reason, you MUST NOT attempt a smaller amount
- NEVER ask the Swap Agent to process a partial payment or smaller amount
- NEVER suggest alternative amounts when a payment fails
- If your payment fails, inform the Swap Service that the payment failed and ask them to cancel the transaction
- You should only request a new swap with a different amount as a completely separate, new transaction
- Think of this like using a credit card - if the full amount is declined, you don't automatically try a smaller charge

IMPORTANT TECHNICAL DETAILS: 
- ALWAYS extract the payment request URL from between the <payment_request_url> and </payment_request_url> markers
- ALWAYS send the receipt between <receipt_url> and </receipt_url> markers
- The receipt contains the payment token and proof of payment`

// ==================== Price Oracle Functions ====================
async function getCurrentExchangeRate(): Promise<number> {
  try {
    const priceUpdates = await pythClient.getLatestPriceUpdates([SOL_USD_PRICE_ID])
    
    if (!priceUpdates?.parsed?.length) {
      logger.warn('No price data available from Pyth, using fallback price')
      return FALLBACK_SOL_PRICE
    }

    const solPriceData = priceUpdates.parsed[0]
    const price = Number(solPriceData.price.price) * Math.pow(10, solPriceData.price.expo)
    
    logger.market('Fetched SOL/USD price from Pyth', {
      'Price': `$${price.toFixed(2)}`,
      'Confidence': `±$${(Number(solPriceData.price.conf) * Math.pow(10, solPriceData.price.expo)).toFixed(2)}`,
      'Updated': new Date(solPriceData.price.publish_time * 1000).toISOString()
    })
    
    return Math.round(price * 100) / 100
    
  } catch (error) {
    logger.error('Error fetching price from Pyth', error)
    logger.info('Using fallback price of $' + FALLBACK_SOL_PRICE)
    return FALLBACK_SOL_PRICE
  }
}

// ==================== Mock DEX Functions ====================
async function executeSwapOnDex(usdcAmount: number, exchangeRate: number) {
  const solAmount = usdcAmount / exchangeRate
  
  logger.swap('Executing swap on DEX', {
    'USDC Amount': usdcAmount,
    'Exchange Rate': `${exchangeRate} USDC/SOL`,
    'SOL Amount': solAmount.toFixed(6)
  })
  
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  return {
    success: true,
    solReceived: solAmount,
    txHash: `0x${Math.random().toString(16).substring(2, 10)}...`
  }
}

async function sendSolToAgent(recipientAddress: string, solAmount: number) {
  logger.transaction('Sending SOL', {
    'Amount': `${solAmount.toFixed(6)} SOL`,
    'Recipient': recipientAddress
  })
  
  await new Promise(resolve => setTimeout(resolve, 500))
  
  return {
    success: true,
    txHash: `0x${Math.random().toString(16).substring(2, 10)}...`
  }
}

// ==================== JWT Utilities ====================
interface JwtPayload {
  vc?: {
    credentialSubject?: {
      paymentToken?: string
    }
  }
  jti?: string
  sub?: string
  iss?: string
  [key: string]: unknown
}

function decodeJwtPayload(jwt: string): JwtPayload {
  const tokenParts = jwt.split('.')
  if (tokenParts.length !== 3) {
    throw new Error("Invalid JWT format")
  }
  return JSON.parse(Buffer.from(tokenParts[1], 'base64').toString()) as JwtPayload
}

function logJwtIfEnabled(jwt: string, label: string) {
  if (!DECODE_JWT || !jwt) return
  
  try {
    const payload = decodeJwtPayload(jwt)
    logger.debug(label, payload)
  } catch (err) {
    logger.warn(`Could not decode JWT: ${label}`, String(err))
  }
}

// ==================== Swap Service ====================
async function runSwapService(message: string) {
  const result = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: SWAP_SERVICE_SYSTEM_PROMPT,
    prompt: message,
    tools: {
      createSwapRequest: tool({
        description: "Create a payment request for the USDC to SOL swap",
        inputSchema: z.object({
          usdcAmount: z.number().describe("Amount of USDC to swap"),
          recipientAddress: z.string().describe("SOL address to receive the swapped SOL").optional()
        }),
        execute: async ({ usdcAmount }) => {
          logger.process('Creating swap request', { 'Amount': `${usdcAmount} USDC` })
          
          const exchangeRate = await getCurrentExchangeRate()
          const solAmount = usdcAmount / exchangeRate
          const paymentUnits = usdcAmount * 100

          const { url: paymentRequestUrl, paymentToken } = await swapServiceSdk.createPaymentRequest(
            paymentUnits,
            { description: `Swap ${usdcAmount} USDC for ${solAmount.toFixed(6)} SOL` }
          )

          if (!paymentRequestUrl) {
            return {
              error: 'Failed to create payment request, no URL returned'
            }
          }

          logger.transaction('Payment token generated', {
            paymentRequestUrl,
            'Exchange rate': `${exchangeRate} USDC/SOL`,
            'Expected SOL': `${solAmount.toFixed(6)} SOL`
          })

          logJwtIfEnabled(paymentToken, 'Decoded payment token JWT payload')

          pendingSwaps.set(paymentToken, {
            usdcAmount,
            paymentRequestUrl,
            solAmount,
            exchangeRate
          })
          
          return {
            paymentRequestUrl,
            usdcAmount,
            exchangeRate,
            solAmount: solAmount.toFixed(6),
            paymentRequired: paymentUnits,
            description: `Swap ${usdcAmount} USDC for ~${solAmount.toFixed(6)} SOL at rate ${exchangeRate} USDC/SOL`,
            instruction: `Please pay ${usdcAmount} USDC (${paymentUnits} units) using this paymentRequestUrl to proceed with the swap`
          }
        }
      }),
      
      executeSwap: tool({
        description: "Execute the swap after payment is confirmed",
        inputSchema: z.object({
          receiptUrl: z.string().url().describe("The URL of the payment receipt JWT from the payment"),
          recipientAddress: z.string().describe("SOL address to send the swapped SOL").optional()
        }),
        execute: async ({ receiptUrl, recipientAddress = "7VQo3HWesNfBys5VXJF3NcE5JCBsRs25pAoBxD5MJYGp", }) => {
          const paymentReceipt = await fetch(receiptUrl).then((res) =>
            res.text()
          )
          // Decode and validate payment receipt
          let paymentToken: string

          try {
            const payload = decodeJwtPayload(paymentReceipt)

            const extractedToken = payload.vc?.credentialSubject?.paymentToken
            if (!extractedToken) {
              return { error: "Payment token not found in receipt" }
            }
            paymentToken = extractedToken

            if (DECODE_JWT) {
              logger.debug('Decoded payment receipt', {
                paymentToken: paymentToken.substring(0, 50) + '...',
                subject: payload.sub,
                issuer: payload.iss
              })
            }
          } catch (err) {
            logger.error('Failed to decode payment receipt', String(err))
            return { error: "Failed to decode payment receipt" }
          }
          
          // Validate pending swap
          const pendingSwap = pendingSwaps.get(paymentToken)
          if (!pendingSwap) {
            return { error: "Invalid or expired payment token" }
          }
          
          if (completedSwaps.has(paymentToken)) {
            return { error: "This swap has already been executed" }
          }
          
          // Execute swap
          const swapResult = await executeSwapOnDex(pendingSwap.usdcAmount, pendingSwap.exchangeRate)
          if (!swapResult.success) {
            return { error: "Swap execution failed" }
          }
          
          // Send SOL to recipient
          const sendResult = await sendSolToAgent(recipientAddress, swapResult.solReceived)
          if (!sendResult.success) {
            return { error: "Failed to send SOL" }
          }
          
          // Mark as completed
          completedSwaps.add(paymentToken)
          pendingSwaps.delete(paymentToken)
          
          return {
            success: true,
            usdcSwapped: pendingSwap.usdcAmount,
            solReceived: swapResult.solReceived.toFixed(6),
            exchangeRate: pendingSwap.exchangeRate,
            recipientAddress,
            swapTxHash: swapResult.txHash,
            sendTxHash: sendResult.txHash,
          }
        }
      })
    },
    stopWhen: stepCountIs(4)
  })

  return result.text
}

// ==================== Swap User ====================
const callSwapService = swapUserSdk.createAgentCaller("http://localhost:7577/chat")

async function runSwapUser(message: string) {
  const result = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system: SWAP_USER_SYSTEM_PROMPT,
    prompt: message,
    tools: {
      callSwapService: tool({
        description: "Call the Swap Service to exchange USDC for SOL",
        inputSchema: z.object({
          message: z.string()
        }),
        execute: async ({ message }) => {
          logger.agent('Calling swap service', message)
          
          try {
            const response = await callSwapService({ message })
            logger.agent('Swap service response', response)
            
            const paymentTokenMatch = response.match(/pay_[a-zA-Z0-9]+/)
            if (paymentTokenMatch) {
              logger.debug('Detected payment token', paymentTokenMatch[0])
            }
            
            return response
          } catch (error) {
            logger.error('Error calling swap service', error)
            return {
              error: true,
              message: error instanceof Error ? error.message : "Unknown error"
            }
          }
        }
      }),
      
      executePayment: tool({
        description: "Execute a USDC payment using a payment request URL received from the Swap Agent",
        inputSchema: z.object({
          paymentRequestUrl: z.string().describe("The URL of the payment request token received from the Swap Agent"),
        }),
        execute: async ({ paymentRequestUrl }) => {
          logger.transaction('Executing USDC payment', {
            paymentRequestUrl,
          })
          
          try {
            const paymentToken = await fetch(paymentRequestUrl).then((res) =>
              res.text()
            )

            logJwtIfEnabled(paymentToken, 'Payment token JWT payload (before execution)')

            const result = await swapUserSdk.executePayment(paymentToken)
            const receiptJwt = result.receipt
            const receiptUrl = result.url

            if (!receiptUrl) {
              return {
                error: 'Failed to execute payment, no receipt URL returned',
              }
            }

            logger.success('Payment successful!', `Receipt ID: ${receiptUrl}`)
            logJwtIfEnabled(receiptJwt, 'Payment receipt JWT payload')

            return {
              success: true,
              receiptUrl,
              amount: 10000, // Default for demo
              usdcPaid: 100,
              message: "USDC payment completed successfully"
            }
          } catch (error) {
            logger.error('Payment failed', error)
            
            const errorWithResponse = error as { response?: { data?: unknown } }
            
            return {
              success: false,
              error: error instanceof Error ? error.message : "Payment failed",
              details: errorWithResponse.response?.data || (error instanceof Error ? error.message : undefined)
            }
          }
        }
      })
    },
    stopWhen: stepCountIs(8)
  })

  return result.text
}

// ==================== Server Initialization ====================
export function startAgentServers() {
  logger.section('STARTING SWAP AGENT SERVERS')
  
  serveAgent({
    port: 7576,
    runAgent: runSwapUser,
    decodeJwt: DECODE_JWT
  })

  serveAuthedAgent({
    port: 7577,
    runAgent: runSwapService,
    sdk: swapServiceSdk,
    decodeJwt: DECODE_JWT
  })

  logger.success('Swap agent servers started')
  logger.server('Swap User', 'http://localhost:7576')
  logger.server('Swap Service', 'http://localhost:7577')
  logger.raw('', 'after')
  logger.info('The swap agents are now ready for interaction')
  logger.separator()
}

// Run servers if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startAgentServers()
}
