const { Octokit } = require('@octokit/rest')
const Clubhouse = require('clubhouse-lib')
const ora = require('ora')
const chalk = require('chalk')
const L = require('lodash');
const fs = require('fs');

const log = console.log

const githubClubhouseImport = async options => {
  validateOptions(options)
  const octokit = new Octokit({
    auth: options.githubToken,
  })

  const [owner, repo] = options.githubUrl.split('/')

  const usersMap = buildUsersMap();

  function buildUsersMap() {
    if (!options.users) {
      return {};
    }

    return L.fromPairs(fs.readFileSync(options.users, "utf-8").split('\n').map(line => line.split(' ').map(x => x.trim())));
  }

  const clubhouse = Clubhouse.create(options.clubhouseToken);
  const members = await clubhouse.listMembers();
  const emailToMembers = L.keyBy(members, member => member.profile.email_address);
  function githubToClubhouseUserId(githubLogin) {
    const email = usersMap[githubLogin];
    if (email) {
      const member = emailToMembers[email];
      if (member) {
        return member.id;
      }
    }
    return undefined;
  }

  const project = await clubhouse.getProject(options.clubhouseProject);
  console.log(`Importing from github ${options.githubUrl} to Clubhouse project ${project.name}`);

  const workflow = (await clubhouse.listWorkflows()).find(workflow => workflow.project_ids.includes(project.id));
  const closedState = workflow.states.find(s => s.type === "done");

  async function fetchGithubIssues() {
    try {
      const githubSpinner = ora('Retrieving issues from Github').start()
      let issues = await octokit.paginate(octokit.issues.listForRepo.endpoint.merge({
        owner,
        repo,
        per_page: 100,
        state: options.state,
        filter: "all"
      }));
      issues = issues.filter(issue => !issue.pull_request);
      githubSpinner.succeed(
        `Retrieved ${chalk.bold(issues.length)} issues from Github`
        );
        
      for (const issue of issues) {
        issue.comments = [];
      }
      const issuesByUrl = L.keyBy(issues, issue => issue.url);
      const commentsSpinner = ora('Retrieving comments from Github').start()
      const comments = await octokit.paginate(octokit.issues.listCommentsForRepo.endpoint.merge({
        owner, repo, per_page: 100, sort: "created", direction: "asc"
      }));
      commentsSpinner.succeed(`Retrieved ${chalk.bold(comments.length)} comments from Github`);
      for (const comment of comments) {
        const issue = issuesByUrl[comment.issue_url];
        if (issue) {
          issue.comments.push(comment);
        }
      }
      return issues;
    } catch (err) {
      spinner.fail(
        `Failed to fetch issues from ${chalk.underline(options.githubUrl)}\n`
      );
      log(chalk.red(err))
    }
  }

  function createImportIssueParams(issue) {
    const { created_at, updated_at, labels, title, body, html_url, user, comments, assignee, closed_at } = issue;
    const story_type = getStoryType(labels);
    const storyRequest = {
      created_at,
      updated_at,
      story_type,
      name: title,
      description: body,
      external_id: html_url,
      project_id: project.id,
      labels: labels.map(label => ({
        description: label.description,
        name: label.name.replace(":", "_"),
      })),
      comments: comments.map(comment => ({
        author_id: githubToClubhouseUserId(comment.user.login),
        created_at: comment.created_at,
        external_id: `${comment.id}`,
        text: comment.body,
        updated_at: comment.updated_at
      })),
      owner_ids: assignee? [githubToClubhouseUserId(assignee.login)].filter(x => x) : []
    };
    if (assignee) {
      const clubhouseAssigneeId = githubToClubhouseUserId(assignee.login);
      if (clubhouseAssigneeId) {
        storyRequest.owner_ids = [clubhouseAssigneeId];
      }
    }
    const clubhouseRequesterId = githubToClubhouseUserId(user.login);
    if (clubhouseRequesterId) {
      storyRequest.requested_by_id = clubhouseRequesterId;
    }
    if (closed_at) {
      storyRequest.workflow_state_id = closedState.id;
      storyRequest.completed_at_override = closed_at;
    }
    return storyRequest;
  }

  async function importIssue(issue) {
    const storyRequest = createImportIssueParams(issue);
    try {
      const res = await clubhouse.createStory(storyRequest);
      log(`Imported issue #${issue.id}`);
      return res;
    } catch (err) {
      log(chalk.red(`Failed to import issue #${issue.id}: ${err}`));
      log(storyRequest);
      log(err);
      return undefined;
    }
  }

  async function importIssues(issues) {
    // TODO: clubhouse.createMultipleStories() doesn't exist, even though the 
    // corresponding REST API call does
    // const requests = issues.map(issue => createImportIssueParams(issue));
    // try {
    //   const result = await clubhouse.createMultipleStories({
    //     stories: requests
    //   });
    //   console.log("RESULT", result);
    //   return result;
    // } catch (err) {
    //   log(chalk.red(`Failed to import issue: ${err}`));
    //   return undefined;
    // }

    const results = [];
    for (const issue of issues) {
      // Doing it one at a time, because there's some API limit for 
      // concurrent requests
      const res = await importIssue(issue);
      if (res) {
        results.push(res);
      }
    }
    return results;
  }

  async function importIssuesToClubhouse(issues) {
    const result = await importIssues(issues);
    // const result = await Promise.allSettled(issues.map(issue => importIssue(issue)));
    const issuesImported = result.filter(x => x).length;
    return issuesImported;
  }

  fetchGithubIssues().then(issues => {
    const clubhouseSpinner = ora('Importing issues into Clubhouse').start()
    importIssuesToClubhouse(issues).then(issuesImported => {
      clubhouseSpinner.succeed(
        `Imported ${chalk.bold(issuesImported)} issues into Clubhouse`
      )
    })
  })
}

const validateOptions = options => {
  let hasError = false
  if (!options.githubToken) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--github-token')} arg is required`))
  }

  if (!options.clubhouseToken) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--clubhouse-token')} arg is required`))
  }

  if (!options.clubhouseProject) {
    hasError = true
    log(
      chalk.red(`Usage: ${chalk.bold('--clubhouse-project')} arg is required`)
    )
  }

  if (!options.githubUrl) {
    hasError = true
    log(chalk.red(`Usage: ${chalk.bold('--github-url')} arg is required`))
  }

  if (!['open', 'closed', 'all'].includes(options.state.toLowerCase())) {
    hasError = true
    log(
      chalk.red(
        `Usage: ${chalk.bold('--state')} must be one of open | closed | all`
      )
    )
  }

  if (hasError) {
    log()
    process.exit(1)
  }
}

function getStoryType(labels) {
  if (labels.find(label => label.name.includes('bug'))) return 'bug'
  if (labels.find(label => label.name.includes('chore'))) return 'chore'
  return 'feature'
}

const reflect = p =>
  p.then(v => ({ v, status: 'fulfilled' }), e => ({ e, status: 'rejected' }))

module.exports.default = githubClubhouseImport
