import {
  type DynamicModule,
  Global,
  Inject,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from "@nestjs/common";
import { type BodyParserOptions, createBodyParser } from "./body-parser";

const BODY_PARSER_OPTIONS = Symbol("BODY_PARSER_OPTIONS");

/**
 * Body parsing for an app created with `bodyParser: false` (see main.ts). Import it once, in
 * AppModule, with the paths that must keep their raw body and the few exact routes allowed a JSON
 * body above the 100 KB default.
 *
 * It is `@Global()` for ordering only: Nest registers global modules' middleware before any other
 * module's, so every controller and every other middleware sees a parsed `req.body` no matter
 * where this sits in the imports list.
 */
@Global()
@Module({})
export class BodyParserModule implements NestModule {
  constructor(@Inject(BODY_PARSER_OPTIONS) private readonly options: BodyParserOptions) {}

  static forRoot(options: BodyParserOptions): DynamicModule {
    return {
      module: BodyParserModule,
      providers: [{ provide: BODY_PARSER_OPTIONS, useValue: options }],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createBodyParser(this.options))
      .forRoutes({ path: "{*splat}", method: RequestMethod.ALL });
  }
}
