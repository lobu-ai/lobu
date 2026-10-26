#!/usr/bin/env bun

import { createLogger, type MessagePayload } from "@lobu/core";
import type { IMessageQueue } from "./types.js";

const logger = createLogger("queue-producer");

/**
 * The `messages` job options for `payload`: one admission per message within
 * its canonical conversation identity while a row is live. Shared by every
 * writer of that queue so they collide on the same singleton key.
 */
export function messagesJobOptions(
  payload: MessagePayload,
  options?: {
    priority?: number;
    retryLimit?: number;
    retryDelay?: number;
    expireInSeconds?: number;
  }
) {
  // Preserve the existing key normalization so retries collide with ordinary admissions.
  const rawSingletonKey = `message-${payload.platform}-${payload.channelId}-${payload.conversationId}-${payload.messageId || Date.now()}`;
  return {
    priority: options?.priority || 0,
    retryLimit: options?.retryLimit || 3,
    retryDelay: options?.retryDelay || 30,
    expireInSeconds: options?.expireInSeconds || 300,
    singletonKey: rawSingletonKey.replace(/:/g, "-"),
  };
}

/**
 * Queue producer for dispatching messages to the runs queue.
 * Handles both direct_message and thread_message queues with bot isolation.
 */
export class QueueProducer {
  private queue: IMessageQueue;
  private isInitialized = false;

  constructor(queue: IMessageQueue) {
    this.queue = queue;
  }

  /**
   * Initialize the queue producer
   * Creates required queues
   */
  async start(): Promise<void> {
    try {
      // Create the messages queue if it doesn't exist
      await this.queue.createQueue("messages");
      this.isInitialized = true;
      logger.debug("Queue producer initialized");
    } catch (error) {
      logger.error("Failed to initialize queue producer:", error);
      throw error;
    }
  }

  /**
   * Stop the queue producer (no-op since queue lifecycle is managed externally)
   */
  async stop(): Promise<void> {
    this.isInitialized = false;
    logger.debug("Queue producer stopped");
  }

  /**
   * Enqueue any message (direct or thread) to the single 'messages' queue
   * Orchestrator will determine if it needs to create a deployment or route to existing thread
   */
  async enqueueMessage(
    payload: MessagePayload,
    options?: {
      priority?: number;
      retryLimit?: number;
      retryDelay?: number;
      expireInSeconds?: number;
    }
  ): Promise<string> {
    if (!this.isInitialized) {
      throw new Error("Queue producer is not initialized");
    }

    try {
      // All messages go to the single 'messages' queue.
      const jobId = await this.queue.send(
        "messages",
        payload,
        messagesJobOptions(payload, options)
      );

      logger.info(
        `Enqueued message job ${jobId} for user ${payload.userId}, conversation ${payload.conversationId}`
      );
      return jobId || "job-sent";
    } catch (error) {
      logger.error(
        `Failed to enqueue message for user ${payload.userId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Check if producer is initialized
   */
  isHealthy(): boolean {
    return this.isInitialized && this.queue.isHealthy();
  }
}
