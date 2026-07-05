


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "private";


ALTER SCHEMA "private" OWNER TO "postgres";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "moddatetime" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "private"."current_household"() RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select household_id from public.household_members
  where user_id = (select auth.uid())
  limit 1;
$$;


ALTER FUNCTION "private"."current_household"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."household_invites" (
    "household_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."household_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."household_members" (
    "household_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'member'::"text" NOT NULL
);


ALTER TABLE "public"."household_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."households" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."households" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthend_items" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "household_id" "uuid" DEFAULT "private"."current_household"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "date_purchased" "text" DEFAULT ''::"text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "enter_amount" numeric DEFAULT 0 NOT NULL,
    "split" boolean DEFAULT true NOT NULL,
    "amount" numeric DEFAULT 0 NOT NULL,
    "fronted_by" "text" DEFAULT 'a'::"text" NOT NULL,
    "owed_by" "text" DEFAULT 'a'::"text" NOT NULL,
    "paid" boolean DEFAULT false NOT NULL,
    "pending" boolean DEFAULT false NOT NULL,
    "payment_id" "text",
    "note" "text" DEFAULT ''::"text" NOT NULL,
    "personal_items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "personal_a" numeric DEFAULT 0 NOT NULL,
    "personal_b" numeric DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."monthend_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."monthend_payments" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "household_id" "uuid" DEFAULT "private"."current_household"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "item_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "from_person" "text",
    "to_person" "text",
    "amount" numeric DEFAULT 0 NOT NULL,
    "period_label" "text" DEFAULT ''::"text" NOT NULL,
    "note" "text" DEFAULT ''::"text" NOT NULL
);


ALTER TABLE "public"."monthend_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."salary_submissions" (
    "id" "text" DEFAULT ("gen_random_uuid"())::"text" NOT NULL,
    "household_id" "uuid" DEFAULT "private"."current_household"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "month" "text" NOT NULL,
    "person_a_name" "text",
    "income_a" numeric,
    "person_b_name" "text",
    "income_b" numeric,
    "transfer_from" "text",
    "transfer_to" "text",
    "transfer_amount" numeric,
    "equal_share" numeric,
    "note" "text",
    "income_items" "jsonb"
);


ALTER TABLE "public"."salary_submissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tool_state" (
    "household_id" "uuid" DEFAULT "private"."current_household"() NOT NULL,
    "tool" "text" NOT NULL,
    "data" "jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tool_state" OWNER TO "postgres";


ALTER TABLE ONLY "public"."household_invites"
    ADD CONSTRAINT "household_invites_pkey" PRIMARY KEY ("household_id", "email");



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_pkey" PRIMARY KEY ("household_id", "user_id");



ALTER TABLE ONLY "public"."households"
    ADD CONSTRAINT "households_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthend_items"
    ADD CONSTRAINT "monthend_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."monthend_payments"
    ADD CONSTRAINT "monthend_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."salary_submissions"
    ADD CONSTRAINT "salary_submissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tool_state"
    ADD CONSTRAINT "tool_state_pkey" PRIMARY KEY ("household_id", "tool");



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."salary_submissions" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



CREATE OR REPLACE TRIGGER "set_updated_at" BEFORE UPDATE ON "public"."tool_state" FOR EACH ROW EXECUTE FUNCTION "extensions"."moddatetime"('updated_at');



ALTER TABLE ONLY "public"."household_invites"
    ADD CONSTRAINT "household_invites_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



ALTER TABLE ONLY "public"."household_members"
    ADD CONSTRAINT "household_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."monthend_items"
    ADD CONSTRAINT "monthend_items_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



ALTER TABLE ONLY "public"."monthend_payments"
    ADD CONSTRAINT "monthend_payments_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



ALTER TABLE ONLY "public"."salary_submissions"
    ADD CONSTRAINT "salary_submissions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



ALTER TABLE ONLY "public"."tool_state"
    ADD CONSTRAINT "tool_state_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id");



CREATE POLICY "hh_all" ON "public"."monthend_items" TO "authenticated" USING (("household_id" = ( SELECT "private"."current_household"() AS "current_household"))) WITH CHECK (("household_id" = ( SELECT "private"."current_household"() AS "current_household")));



CREATE POLICY "hh_all" ON "public"."monthend_payments" TO "authenticated" USING (("household_id" = ( SELECT "private"."current_household"() AS "current_household"))) WITH CHECK (("household_id" = ( SELECT "private"."current_household"() AS "current_household")));



CREATE POLICY "hh_all" ON "public"."salary_submissions" TO "authenticated" USING (("household_id" = ( SELECT "private"."current_household"() AS "current_household"))) WITH CHECK (("household_id" = ( SELECT "private"."current_household"() AS "current_household")));



CREATE POLICY "hh_all" ON "public"."tool_state" TO "authenticated" USING (("household_id" = ( SELECT "private"."current_household"() AS "current_household"))) WITH CHECK (("household_id" = ( SELECT "private"."current_household"() AS "current_household")));



CREATE POLICY "hh_read" ON "public"."households" FOR SELECT TO "authenticated" USING (("id" = ( SELECT "private"."current_household"() AS "current_household")));



CREATE POLICY "hm_read" ON "public"."household_members" FOR SELECT TO "authenticated" USING (("household_id" = ( SELECT "private"."current_household"() AS "current_household")));



ALTER TABLE "public"."household_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."household_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."households" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthend_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."monthend_payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."salary_submissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tool_state" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "private" TO "authenticated";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";








































































































































































GRANT ALL ON TABLE "public"."household_invites" TO "anon";
GRANT ALL ON TABLE "public"."household_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."household_invites" TO "service_role";



GRANT ALL ON TABLE "public"."household_members" TO "anon";
GRANT ALL ON TABLE "public"."household_members" TO "authenticated";
GRANT ALL ON TABLE "public"."household_members" TO "service_role";



GRANT ALL ON TABLE "public"."households" TO "anon";
GRANT ALL ON TABLE "public"."households" TO "authenticated";
GRANT ALL ON TABLE "public"."households" TO "service_role";



GRANT ALL ON TABLE "public"."monthend_items" TO "anon";
GRANT ALL ON TABLE "public"."monthend_items" TO "authenticated";
GRANT ALL ON TABLE "public"."monthend_items" TO "service_role";



GRANT ALL ON TABLE "public"."monthend_payments" TO "anon";
GRANT ALL ON TABLE "public"."monthend_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."monthend_payments" TO "service_role";



GRANT ALL ON TABLE "public"."salary_submissions" TO "anon";
GRANT ALL ON TABLE "public"."salary_submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."salary_submissions" TO "service_role";



GRANT ALL ON TABLE "public"."tool_state" TO "anon";
GRANT ALL ON TABLE "public"."tool_state" TO "authenticated";
GRANT ALL ON TABLE "public"."tool_state" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































drop extension if exists "pg_net";


