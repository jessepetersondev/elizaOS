import { IAgentRuntime } from '@elizaos/core';
import Airtable from 'airtable';
import { elizaLogger } from "@elizaos/core";

export interface AirtableConfig {
    AIRTABLE_API_KEY: string | null;
    AIRTABLE_BASE_ID: string | null;
    AIRTABLE_TABLE_NAME: string | null;
}

export async function createAirtableRecord(data: Record<string, any>, runtime: IAgentRuntime, tableName: string): Promise<string | null> {
    try {
        const airtableApiKey = runtime.getSetting('AIRTABLE_API_KEY');
        const airtableBaseId = runtime.getSetting('AIRTABLE_BASE_ID');
        const airtableTableName = tableName;

        const airtableBase = new Airtable({ apiKey: airtableApiKey }).base(airtableBaseId);

        elizaLogger.log(`Creating new Airtable record with data:`, data);

        const result = await airtableBase(airtableTableName).create(data);

        elizaLogger.log(`Successfully created Airtable record with ID: ${result.id}`);
        return result.id;
    } catch (error) {
        elizaLogger.error(`Failed to create Airtable record:`, error);
        return null;
    }
}

export async function updateAirtableStatus(tokenAddress: string, newStatus: string, runtime: IAgentRuntime, tableName: string) {
    try {
        const config: AirtableConfig = {
            AIRTABLE_API_KEY: runtime.getSetting("AIRTABLE_API_KEY"),
            AIRTABLE_BASE_ID: runtime.getSetting("AIRTABLE_BASE_ID"),
            AIRTABLE_TABLE_NAME: tableName
        };
        const airtableBase = new Airtable({ apiKey: config.AIRTABLE_API_KEY }).base(config.AIRTABLE_BASE_ID);
        const records = await airtableBase(config.AIRTABLE_TABLE_NAME)
            .select({
                filterByFormula: `{Mint} = '${tokenAddress}'`
            })
            .firstPage();

        if (records && records.length > 0) {
            await airtableBase(config.AIRTABLE_TABLE_NAME).update([
                {
                    id: records[0].id,
                    fields: {
                        Status: [newStatus]
                    }
                }
            ]);
            elizaLogger.log(`Updated Airtable status for token ${tokenAddress} to "${newStatus}"`);
        }
    } catch (error) {
        elizaLogger.error(`Error updating Airtable status for ${tokenAddress}:`, error);
    }
}

export async function updateFreqtradeAirtableStatus(jobID: string, processType: string, runtime: IAgentRuntime) {
    try {
        const config: AirtableConfig = {
            AIRTABLE_API_KEY: runtime.getSetting("AIRTABLE_API_KEY"),
            AIRTABLE_BASE_ID: runtime.getSetting("AIRTABLE_BASE_ID"),
            AIRTABLE_TABLE_NAME: "FreqtradeProcessing"
        };
        const airtableBase = new Airtable({ apiKey: config.AIRTABLE_API_KEY }).base(config.AIRTABLE_BASE_ID);
        const records = await airtableBase(config.AIRTABLE_TABLE_NAME)
            .select({
                filterByFormula: `AND({JobID} = '${jobID}',{ProcessType} = '${processType}')`
            })
            .firstPage();

        if (records && records.length > 0) {
            await airtableBase(config.AIRTABLE_TABLE_NAME).update([
                {
                    id: records[0].id,
                    fields: {
                        CompleteDatetime: new Date().toISOString()
                    }
                }
            ]);
            elizaLogger.log(`Updated Airtable status for token ${jobID} to complete"`);
        }
    } catch (error) {
        elizaLogger.error(`Error updating Airtable status for ${jobID}:`, error);
    }
}