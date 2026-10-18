import { ruleDefinitionSchema, testRuleRequestSchema } from "@personal-api/contracts";
import { createZodDto } from "nestjs-zod";

// Keep these as value imports in the controller: the global pipe finds the schema through the class.
export class RuleDefinitionDto extends createZodDto(ruleDefinitionSchema) {}
export class TestRuleDto extends createZodDto(testRuleRequestSchema) {}
